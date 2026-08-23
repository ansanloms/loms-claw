/**
 * Discord ボットの本体。
 *
 * messageCreate イベントを受け取り、認可チェックと反応判定を行い、
 * Claude Code CLI を呼び出して応答を返す。
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  MessageFlags,
  type RepliableInteraction,
  REST,
  Routes,
} from "discord.js";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import {
  askClaude,
  extractTopLevelTextDelta,
  extractTopLevelThinkingDelta,
  handleResultEvent,
  requireResultText,
} from "../claude/mod.ts";
import type { Store } from "../store/mod.ts";
import { ApprovalManager, createCanUseTool } from "../approval/manager.ts";
import {
  command,
  handleSettingsSet,
  handleSettingsShow,
  handleSettingsUnset,
} from "./commands.ts";
import {
  isAuthorized,
  isAuthorizedSelfMessage,
  shouldRespond,
} from "./guard.ts";
import {
  SELF_MENTION_RATE_LIMIT_MAX_COUNT,
  SELF_MENTION_RATE_LIMIT_WINDOW_MINUTES,
  SelfMentionRateLimiter,
} from "./ratelimit.ts";
import { ScopeQueue } from "./queue.ts";
import { splitAtBoundary } from "./flush.ts";
import { scopeFromChannel } from "./scope.ts";
import {
  appendImageReferences,
  cleanupImageFiles,
  createProgressReporter,
  DISCORD_MESSAGE_LIMIT,
  type DownloadedImage,
  downloadImageAttachments,
  keepTyping,
  splitMessage,
  stripBotMentions,
} from "./message.ts";
import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";
import { SystemPromptStore } from "../claude/system-prompt.ts";
import { startApiServer } from "../api/server.ts";
import type { CronRouteContext } from "../api/routes/cron.ts";
import type { SettingsRouteContext } from "../api/routes/settings.ts";
import { CronExecutor } from "../cron/executor.ts";
import { loadCronJobsFromDir } from "../cron/loader.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("bot");

/**
 * shutdown() で API サーバー停止 (apiServer.shutdown()) を待つ上限 (ミリ秒)。
 * 超過した場合は警告を出して Discord クライアント破棄へ進む。
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * AI to AI 自己メンションで起動したターンのプロンプト先頭に付ける注記。
 * 発話者のテンプレート変数は認可ユーザーに差し替えるため、この注記が無いと
 * モデルは人間の発話と区別できない。
 */
const SELF_MENTION_PROMPT_NOTE =
  "[AI to AI 自己メンション] この依頼は認可ユーザー本人の発話ではなく、別のチャンネル/スレッドで動いている自 bot のセッションが投稿したもの。";

/**
 * インタラクションのハンドラを実行し、失敗時にログとエフェメラル返信で揃える。
 *
 * button / select メニュー / Modal 送信の 3 ハンドラが同形の
 * `try { handler } catch { log.error; if (!replied && !deferred) reply(ephemeral) }`
 * を持っていたため、ここに集約する。ログ文言・エラー返信文言は呼び出し側から渡す
 * (各分岐の現行の文言を変えない)。
 */
async function runInteraction(
  interaction: RepliableInteraction,
  label: string,
  handler: () => Promise<unknown>,
  errorMessage: string,
): Promise<void> {
  try {
    await handler();
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    log.error(`${label} interaction error:`, msg);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: errorMessage,
        flags: MessageFlags.Ephemeral,
      }).catch(() => {});
    }
  }
}

/**
 * Discord ボット。
 */
export class DiscordBot {
  private client: Client;
  private config: Config;
  private store: Store;
  private approvalManager: ApprovalManager;
  private apiServer: Deno.HttpServer | null = null;
  private cronExecutor: CronExecutor | null = null;
  private systemPrompts: SystemPromptStore;
  /** scope (channel / thread) 単位でメッセージ処理を直列化するキュー。 */
  private chatQueue = new ScopeQueue();
  /** 自己メンション応答のレート制限 (bot 全体のスライディングウィンドウ)。 */
  private selfMentionLimiter: SelfMentionRateLimiter;

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
    this.selfMentionLimiter = new SelfMentionRateLimiter(
      SELF_MENTION_RATE_LIMIT_MAX_COUNT,
      SELF_MENTION_RATE_LIMIT_WINDOW_MINUTES,
    );
    this.systemPrompts = new SystemPromptStore(
      join(config.claude.cwd, ".claude", "system-prompt"),
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      // この discord.js Client 経由で送信する全メッセージ (応答・cron 投稿・
      // 承認ボタン等) で、メンション解決を認可ユーザー (本人) 宛てのみに限定する。
      // 本人へのピングは通り、bot 自身・他ユーザー・role・everyone は解決されない
      // ため、応答本文に `<@botId>` が紛れても自己メンションの発火条件
      // (message.mentions に自 bot が載ること) を満たさない。
      // Claude が discord skill の curl (REST API) で直接投稿するメッセージには
      // 効かない。それが AI to AI 自己メンションの意図した起動経路であり、
      // その側の歯止めはレート制限 (selfMentionLimiter) が担う。
      allowedMentions: { parse: [], users: [config.discord.userId] },
    });
    this.approvalManager = new ApprovalManager(
      this.client,
      join(config.claude.cwd, ".claude", "settings.json"),
    );

    this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));
    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i));
  }

  /**
   * bot を起動する。Discord gateway に接続し、スラッシュコマンドを登録する。
   */
  async start(): Promise<void> {
    await this.systemPrompts.load();

    // ClientReady の listener は login() より前に登録する。
    // discord.js は gateway の READY を受けると ClientReady を emit するが、
    // このタイミングは login() の解決前になり得るため、login() の後に
    // once() を登録すると発火済みイベントを取りこぼし、コマンド登録・
    // cron 初期化・API サーバー起動が永久に実行されない。
    const ready = new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, async (c) => {
        log.info(`logged in as ${c.user.tag}`);
        await this.registerCommands();

        // cron 初期化。
        this.cronExecutor = new CronExecutor(
          this.client,
          this.config.claude,
          this.config.discord.guildId,
          this.config.discord.token,
          this.store,
          this.config.claude.defaults,
          this.approvalManager,
          this.systemPrompts,
        );

        const cronJobs = await loadCronJobsFromDir(this.config.claude.cwd);
        this.cronExecutor.start(cronJobs);

        const reloadJobs = async () => {
          const jobs = await loadCronJobsFromDir(this.config.claude.cwd);
          this.cronExecutor!.reload(jobs);
        };

        // once ジョブのコールバック: ファイル削除 → reload
        this.cronExecutor.setOnceCallback(async (jobName: string) => {
          const filePath = join(
            this.config.claude.cwd,
            "cron",
            `${jobName}.md`,
          );
          try {
            await Deno.remove(filePath);
            log.info(`once job file deleted: ${filePath}`);
          } catch (e) {
            log.error(`failed to delete once job file: ${filePath}`, e);
          }
          await reloadJobs();
        });

        // 手動実行関数
        const runJobByName = async (name: string) => {
          const job = this.cronExecutor!.findJob(name);
          if (!job) {
            throw new Error(`job not found: ${name}`);
          }
          await this.cronExecutor!.runJob(job);
        };

        // 統合 API サーバーを起動する（cron + ログ取得 + 設定）。
        const cronCtx: CronRouteContext = {
          reloadCronJobs: reloadJobs,
          runJob: runJobByName,
          listJobs: () => this.cronExecutor!.listJobs(),
        };
        const settingsCtx: SettingsRouteContext = {
          store: this.store,
          resolveParentId: (id) => this.resolveThreadParentId(id),
        };
        this.apiServer = startApiServer(
          this.config.claude.apiPort,
          settingsCtx,
          cronCtx,
        );

        resolve();
      });
    });

    await this.client.login(this.config.discord.token);

    await ready;
  }

  /**
   * bot をシャットダウンする。
   *
   * HTTP サーバー停止 (最大 SHUTDOWN_TIMEOUT_MS ms で打ち切り) → Discord
   * クライアント破棄 (await) の順で処理する。破棄後、呼び出し元 (main.ts) が
   * store.close() → Deno.exit(0) で明示的にプロセスを終了する (Store の
   * open / close は main.ts が対で所有する)。
   */
  async shutdown(): Promise<void> {
    log.info("shutting down");
    this.cronExecutor?.stop();

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timeoutId = setTimeout(() => {
        log.warn("api server shutdown timed out; proceeding");
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);
    });
    await Promise.race([
      this.apiServer?.shutdown().catch((e) =>
        log.warn("api server shutdown error:", e)
      ) ?? Promise.resolve(),
      timeout,
    ]);
    clearTimeout(timeoutId);

    await this.client.destroy();
    log.info("shutdown sequence complete");
  }

  /**
   * スラッシュコマンドを対象ギルドに登録する。
   */
  private async registerCommands(): Promise<void> {
    const rest = new REST().setToken(this.config.discord.token);

    await rest.put(
      Routes.applicationGuildCommands(
        this.client.user!.id,
        this.config.discord.guildId,
      ),
      { body: [command.toJSON()] },
    );

    log.info("registered slash commands");
  }

  /**
   * 指定 ID がスレッドならその親チャンネル ID を、そうでなければ null を返す。
   *
   * settings ルートの `resolveParentId` として注入される。`channels.fetch()` は
   * 存在しない ID や cron の擬似 id (`cron:{name}`) 等で throw しうるが、ここでは
   * 握りつぶさずそのまま素通しする。呼び出し元 (settings ルートの resolveScope())
   * が catch してチャンネル扱いへフォールバックする設計のため。
   */
  private async resolveThreadParentId(id: string): Promise<string | null> {
    const channel = await this.client.channels.fetch(id);
    return channel?.isThread() ? channel.parentId : null;
  }

  /**
   * スラッシュコマンドのハンドラ。
   */
  private async onInteraction(interaction: Interaction): Promise<void> {
    // ボタンインタラクション（承認/拒否、質問の Cancel）
    if (interaction.isButton()) {
      await runInteraction(
        interaction,
        "button",
        () => this.approvalManager.handleButton(interaction),
        "承認処理中にエラーが発生しました。",
      );
      return;
    }

    // select メニュー（AskUserQuestion の回答）
    if (interaction.isStringSelectMenu()) {
      await runInteraction(
        interaction,
        "select",
        () => this.approvalManager.handleSelect(interaction),
        "回答処理中にエラーが発生しました。",
      );
      return;
    }

    // Modal 送信（AskUserQuestion の Other 自由入力）
    if (interaction.isModalSubmit()) {
      await runInteraction(
        interaction,
        "modal",
        () => this.approvalManager.handleModal(interaction),
        "回答処理中にエラーが発生しました。",
      );
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }
    if (interaction.commandName !== command.name) {
      return;
    }

    // 認可チェック
    if (
      !isAuthorized(
        interaction.guildId,
        interaction.user.id,
        interaction.user.bot,
        this.config,
      )
    ) {
      return;
    }

    const group = interaction.options.getSubcommandGroup();
    const sub = interaction.options.getSubcommand();

    // /claw settings <sub>
    if (group === "settings") {
      if (sub === "show") {
        return handleSettingsShow(interaction, {
          store: this.store,
          defaults: this.config.claude.defaults,
          cronExecutor: this.cronExecutor,
          activeChannelIds: this.config.discord.activeChannelIds,
        });
      }
      if (sub === "set") {
        return handleSettingsSet(interaction, this.store);
      }
      if (sub === "unset") {
        return handleSettingsUnset(interaction, this.store);
      }
      return;
    }
  }

  /**
   * メッセージ受信時のメインハンドラ。
   */
  private async onMessage(message: Message): Promise<void> {
    // bot 自身のメッセージは、自己メンション (別スコープの自 bot からの明示メンション)
    // として条件付きで処理する。isAuthorizedSelfMessage() が false のメッセージ
    // (他 bot・他ユーザー・ギルド外の自 bot) は従来どおり isAuthorized() で判定し、
    // bot は isAuthorized() で必ず拒否される。
    const botUserId = this.client.user?.id ?? null;
    const isSelfMessage = isAuthorizedSelfMessage(
      message.guildId,
      message.author.id,
      botUserId,
      this.config,
    );
    if (
      !isSelfMessage &&
      !isAuthorized(
        message.guildId,
        message.author.id,
        message.author.bot,
        this.config,
      )
    ) {
      return;
    }

    // スコープ抽出 (反応判定で per-scope の active 上書きを引くために先に必要)。
    // 組み立て方の詳細・型ナローイングの注意書きは scopeFromChannel 側にまとめてある。
    const scope = scopeFromChannel(message.channel, message.channelId);
    // shouldRespond() は raw な parentId (親が無ければ null のまま) を要求する。
    // scope.channelId は Store 用にフォールバック済みなので代用できず、別途
    // 抽出する。`message.channel.isThread()` は `this is ThreadChannel` の
    // type guard で、判定結果を const に寄せても後続の parentId 参照は
    // narrowing が効く (TS の aliased condition narrowing)。
    const isThread = message.channel.isThread();
    const parentId = isThread ? message.channel.parentId : null;
    // 承認ボタン・systemPrompt 解決・テンプレート変数は「発話があった場所」を見せたい。
    // スレッド内ならスレッド ID、通常チャンネルなら channel ID。
    const localId = scope.threadId ?? scope.channelId;

    // 反応判定。
    // 自己メッセージでは本文中の `<@botId>` (parsedUsers 由来) だけを明示メンション
    // とみなす。`mentions.has()` の既定判定は bot 投稿への返信ピング (gateway の
    // mentions 配列に返信先が入る)・@everyone・bot が持つ role へのメンションでも
    // true を返すため、ignoreRepliedUser / ignoreEveryone / ignoreRoles を指定して
    // 除外する。人間のメッセージは従来どおり既定の `mentions.has()` で判定する。
    const isMentioned = this.client.user
      ? message.mentions.has(
        this.client.user,
        isSelfMessage
          ? { ignoreRepliedUser: true, ignoreEveryone: true, ignoreRoles: true }
          : {},
      )
      : false;
    // 自己メッセージはメンションが無ければここで捨てる。bot 自身の全投稿 (応答の
    // 分割送信・thinking・進捗・cron 投稿等) がこのハンドラを通るため、KV 読み
    // (getActive) の前に落として無駄な I/O を避ける。
    if (isSelfMessage && !isMentioned) {
      return;
    }
    // 自己メッセージの反応判定は上の明示メンション判定で完結する。`active` は
    // 人間のメッセージにのみ効く設定 (true なら mention 不要) であり、自己
    // メッセージには適用しない (true でも mention 必須、false でも mention が
    // あれば反応する)。
    if (!isSelfMessage) {
      const hasNonBotMentions = message.mentions.users.some((u) => !u.bot);
      const activeOverride = await this.store.getActive(scope);
      if (
        !shouldRespond(
          message.channelId,
          this.config.discord.activeChannelIds,
          isThread,
          parentId,
          isMentioned,
          hasNonBotMentions,
          activeOverride,
        )
      ) {
        return;
      }
    }

    // cleanContent は `<@botId>` を guild ニックネーム優先の表示名 (`@Nick`) に
    // 展開するため、グローバル表示名とニックネームの両方を除去対象に渡す。
    let prompt = stripBotMentions(message.cleanContent, [
      this.client.user?.displayName ?? "",
      message.guild?.members.me?.displayName ?? "",
    ]);

    const hasAttachments = message.attachments.size > 0;

    // テキストも添付もなければ無視
    if (!prompt && !hasAttachments) {
      return;
    }

    const channel = message.channel as GuildTextBasedChannel;

    // 自己メンションのレート枠が到着時点で既に尽きていれば、キューに積まず
    // ここで捨てる (typing・添付ダウンロード等の副作用を起こさない)。枠の
    // 予約はせず、消費は query 実行直前の tryConsume で行うため、busy な
    // スコープに複数の自己メンションが積まれた場合は実行時に改めて弾かれる。
    if (isSelfMessage && this.selfMentionLimiter.isExhausted()) {
      log.warn(
        `self-mention rate limit exceeded, ignoring message in ${message.channelId}`,
      );
      return;
    }

    // bot が応答中の scope に届いたメッセージは直列キューに積み、現在のターンが
    // 終わってから同一セッションで処理する (Claude Code が応答生成中の入力を
    // キューに積み、ターン終了後に処理するのと同じ挙動)。これにより同一 scope
    // への並行 query を防ぎ、session_id の競合を構造的に無くす。
    //
    // isBusy 判定と enqueue 登録の間に await を挟まないこと。挟むと連投時に後続
    // メッセージの enqueue が先に登録されて順序が入れ替わりうる。react は
    // fire-and-forget にして await しない。
    const wasQueued = this.chatQueue.isBusy(localId);
    if (wasQueued) {
      // 待機に入ったことを発言者へ可視化する。失敗は致命的でないので握り潰す。
      message.react("⏳").catch(() => {});
    }

    await this.chatQueue.enqueue(localId, async () => {
      // 自分のターンが始まったら待機マーカー (⏳) を外す。
      if (wasQueued && this.client.user) {
        await message.reactions.cache.get("⏳")?.users
          .remove(this.client.user.id)
          .catch(() => {});
      }

      // typing インジケーター開始
      const typingController = new AbortController();
      keepTyping(channel, typingController.signal);

      const progress = createProgressReporter(channel);
      let downloadedImages: DownloadedImage[] = [];

      // 応答は発言者宛にする: 分割後のすべての投稿の先頭にメンションを付ける。
      // メンション分を引いた上限で分割してから各チャンク先頭に付与することで、
      // どのチャンクでも上限ぎりぎりでメンション分が溢れない（2000 字超過しない）。
      // 自己メッセージ起動時は空文字にする: 応答冒頭に自 bot メンションを付けると、
      // 応答自体が再度メンション条件を満たし連鎖の火種になるため。
      // 発話者 (認可ユーザー) へのピングは Client 既定の allowedMentions で通る。
      const mention = isSelfMessage ? "" : `<@${message.author.id}> `;
      const sendChunks = async (text: string): Promise<void> => {
        const chunks = splitMessage(
          text,
          DISCORD_MESSAGE_LIMIT - mention.length,
        );
        for (const chunk of chunks) {
          await channel.send(mention + chunk);
        }
      };

      // thinking (推論) を引用形式で投稿する。回答ではないのでメンションは付けず、
      // Discord の `> ` 引用で回答と視覚的に分離する。
      const sendThinking = async (text: string): Promise<void> => {
        const quoted = text.split("\n").map((line) => `> ${line}`).join("\n");
        for (const chunk of splitMessage(quoted)) {
          await channel.send(chunk);
        }
      };

      try {
        // 画像添付をダウンロード（画像フィルタは downloadImageAttachments 内で行う）
        if (hasAttachments) {
          downloadedImages = await downloadImageAttachments(
            message.attachments.values(),
          );
          if (downloadedImages.length > 0) {
            prompt = appendImageReferences(
              prompt || "この画像について説明して",
              downloadedImages,
            );
          }
        }

        // 画像ダウンロード後もプロンプトが空なら終了
        if (!prompt) {
          return;
        }

        // 自己メンション応答のレート枠は、実際に query を実行する直前にのみ消費する
        // (空プロンプト等で応答しないメッセージに枠を浪費しない)。
        if (isSelfMessage && !this.selfMentionLimiter.tryConsume()) {
          log.warn(
            `self-mention rate limit exceeded, ignoring message in ${message.channelId}`,
          );
          return;
        }

        // 自己起動ターンでは、この依頼が人間の発話ではなく別スコープの自 bot
        // セッションからのものだとモデルに伝える (発話者変数は本人に差し替える
        // ため、これが無いと人間の発話と区別できない)。
        if (isSelfMessage) {
          prompt = `${SELF_MENTION_PROMPT_NOTE}\n\n${prompt}`;
        }

        // テンプレート変数の発話者。自己メンション起動時の message.author は自 bot
        // だが、そのまま渡すと「発話者へメンションせよ」というプロンプト指示が
        // `<@botId>` を生み、自己メンションの再発火 (連鎖) につながる。自己起動時は
        // 認可ユーザー (本人) を発話者として渡す。
        const speakerId = isSelfMessage
          ? this.config.discord.userId
          : message.author.id;
        const speakerName = isSelfMessage
          ? message.guild?.members.cache.get(speakerId)?.displayName ??
            this.client.users.cache.get(speakerId)?.displayName ??
            speakerId
          : message.author.displayName;
        const [sessionId, model, effort, showThinking] = await Promise.all([
          this.store.getSession(scope),
          this.store.getModel(scope),
          this.store.getEffort(scope),
          this.store.getShowThinking(scope),
        ]);

        const templateVars: Record<string, string> = {
          "discord.guild.id": this.config.discord.guildId,
          "discord.guild.name": message.guild?.name ?? "",
          "discord.channel.id": localId,
          "discord.channel.name": "name" in channel ? channel.name ?? "" : "",
          "discord.channel.type": isThread ? "thread" : "text",
          "discord.user.id": speakerId,
          "discord.user.name": speakerName,
        };

        const appendSystemPrompt = this.systemPrompts.resolve(
          "chat",
          scope,
          templateVars,
        );

        const stream = askClaude(prompt, {
          sessionId,
          config: this.config.claude,
          discordToken: this.config.discord.token,
          signal: AbortSignal.timeout(this.config.claude.timeout),
          appendSystemPrompt,
          model,
          effort,
          canUseTool: createCanUseTool(this.approvalManager, localId),
        });

        // ストリーミング応答: text_delta をバッファに蓄積し、
        // 閾値を超えたら文境界で区切って中間投稿する。
        // 分割アルゴリズム自体は splitAtBoundary (bot/flush.ts) に切り出してある。
        const FLUSH_THRESHOLD = 800;
        let textBuffer = "";
        let hasStreamedText = false;
        let resultEvent: SDKResultMessage | undefined;

        const flushBuffer = async (force: boolean) => {
          const result = splitAtBoundary(textBuffer, FLUSH_THRESHOLD, force);
          if (!result) {
            return;
          }
          textBuffer = result.rest;
          if (result.send) {
            hasStreamedText = true;
            await sendChunks(result.send);
          }
        };

        // thinking 用バッファ。回答テキストとは独立に文境界でフラッシュする。
        // 回答より閾値を高めにして、推論の中間投稿で本文が埋もれないようにする。
        const THINKING_FLUSH_THRESHOLD = 1500;
        let thinkingBuffer = "";

        const flushThinking = async (force: boolean) => {
          const result = splitAtBoundary(
            thinkingBuffer,
            THINKING_FLUSH_THRESHOLD,
            force,
          );
          if (!result) {
            return;
          }
          thinkingBuffer = result.rest;
          if (result.send) {
            await sendThinking(result.send);
          }
        };

        for await (const event of stream) {
          const delta = extractTopLevelTextDelta(event);
          const thinkingDelta = showThinking
            ? extractTopLevelThinkingDelta(event)
            : undefined;
          if (delta !== undefined) {
            // 回答テキストが来たら、未送出の thinking を先に出して順序を保つ。
            if (thinkingBuffer) {
              await flushThinking(true);
            }
            textBuffer += delta;
            if (textBuffer.length >= FLUSH_THRESHOLD) {
              await flushBuffer(false);
            }
          } else if (thinkingDelta !== undefined) {
            thinkingBuffer += thinkingDelta;
            if (thinkingBuffer.length >= THINKING_FLUSH_THRESHOLD) {
              await flushThinking(false);
            }
          } else if (event.type === "assistant" && !event.parent_tool_use_id) {
            // トップレベルの assistant メッセージ 1 件が完成した時点で強制フラッシュ。
            // Claude が「テキスト → ツール実行 → テキスト」と複数の応答に分かれて
            // 喋る場合、各応答を別々の Discord 投稿として区切るため。閾値による
            // 途中フラッシュ (上の delta 分岐) は応答内のストリーミング体感のために残す。
            await flushThinking(true);
            await flushBuffer(true);
          } else if (event.type === "result") {
            resultEvent = event;
            // 非 success の subtype (error_max_turns 等) は Docker logs から原因を追えるよう詳細を残す。
            // 非ゼロ終了でジェネレータがスローしてもセッションが残るよう即座に保存する。
            await handleResultEvent(event, {
              onNonSuccess: (event) =>
                log.warn(
                  `claude returned non-success subtype "${event.subtype}":`,
                  JSON.stringify(event),
                ),
              setSession: (sessionId) =>
                this.store.setSession(scope, sessionId),
            });
          } else if (event.type === "tool_progress") {
            await progress.report(event.tool_name, event.elapsed_time_seconds);
          }
        }

        // バッファに残った thinking / テキストを投稿。
        await flushThinking(true);
        await flushBuffer(true);

        // stream_event がなかった場合は result.result からフォールバック。
        if (!hasStreamedText) {
          const text = requireResultText(resultEvent);
          await sendChunks(text);
        }
      } catch (error: unknown) {
        // logger は Error の stack を自動で展開する。
        log.error("failed to process message:", error);
        const errMsg = getErrorMessage(error);
        // エラーもまだ何も送っていなければ発言者宛にする（content 送出済みなら継続扱い）。
        await sendChunks(`Error: ${errMsg}`).catch(() => {});
      } finally {
        if (downloadedImages.length > 0) {
          await cleanupImageFiles(downloadedImages);
        }
        await progress.cleanup();
        typingController.abort();
      }
    });
  }
}
