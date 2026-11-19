/**
 * Discord ボットの本体。
 *
 * messageCreate イベントを受け取り、認可チェックと反応判定を行い、
 * Agent SDK (`askClaude()`) を呼び出して応答を返す。
 */

import { rm } from "node:fs/promises";
import { join } from "@std/path/join";
import type { ServerType } from "@hono/node-server";
import {
  Client,
  Events,
  GatewayIntentBits,
  type GuildTextBasedChannel,
  type Interaction,
  type Message,
  MessageFlags,
  REST,
  type RepliableInteraction,
  Routes,
  Status,
} from "discord.js";
import type { CronRouteContext } from "../../api/routes/cron.ts";
import type { HealthRouteContext } from "../../api/routes/health.ts";
import type { SettingsRouteContext } from "../../api/routes/settings.ts";
import { startApiServer } from "../../api/server.ts";
import { SystemPromptStore } from "../../claude/system-prompt.ts";
import type { Config } from "../../config.ts";
import { Conversation, type TurnOutput } from "../../core/conversation.ts";
import {
  SELF_MENTION_RATE_LIMIT_MAX_COUNT,
  SELF_MENTION_RATE_LIMIT_WINDOW_MINUTES,
  SelfMentionRateLimiter,
} from "../../core/ratelimit.ts";
import { CronExecutor } from "../../cron/executor.ts";
import { loadCronJobsFromDir } from "../../cron/loader.ts";
import { getErrorMessage, summarizeError } from "../../errors.ts";
import { createLogger } from "../../logger.ts";
import type { Store } from "../../store/mod.ts";
import { ApprovalManager, createCanUseTool } from "./approval/manager.ts";
import { createDiscordCronPorts } from "./cron-target.ts";
import {
  command,
  handleSettingsSet,
  handleSettingsShow,
  handleSettingsUnset,
} from "./commands.ts";
import { isAuthorized } from "./guard.ts";
import { resolveIncomingMessage } from "./incoming.ts";
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

const log = createLogger("bot");

/**
 * shutdown() で API サーバー停止・Discord クライアント破棄それぞれを待つ上限
 * (ミリ秒)。両ステップに個別に適用するため、shutdown() 全体の最大所要時間は
 * この 2 倍になり得る (合計最大 10 秒。Docker 側の stop_grace_period は
 * それに合わせて 15 秒を確保している。compose.yaml 参照)。
 */
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * `promise` を `ms` ミリ秒でタイムアウトさせるヘルパ。
 *
 * タイムアウトした場合は `log.warn("<label> timed out; proceeding")` を出して
 * resolve する (reject しない、呼び出し元の処理は先へ進む)。`promise` 自体の
 * reject は呼び出し元が事前に catch しておくこと (このヘルパは reject を
 * 変換しない)。どちらが先に決着してもタイマーは clearTimeout する。
 */
async function withTimeout(
  promise: Promise<void>,
  ms: number,
  label: string,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      log.warn(`${label} timed out; proceeding`);
      resolve();
    }, ms);
  });
  await Promise.race([promise, timeout]);
  clearTimeout(timeoutId);
}

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
      await interaction
        .reply({
          content: errorMessage,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
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
  private apiServer: ServerType | null = null;
  private cronExecutor: CronExecutor | null = null;
  private systemPrompts: SystemPromptStore;
  /** 会話の中核 (キュー・セッション・ストリーム消費)。Discord には依存しない。 */
  private conversation: Conversation;
  /**
   * `query()` の env へ注入する環境変数。discord skill の curl がここから
   * bot トークンを取る (skill 側は config.json を直読みしない)。
   */
  private readonly queryEnv: Record<string, string>;

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
    this.queryEnv = { DISCORD_BOT_TOKEN: config.discord.token };
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

    this.conversation = new Conversation({
      store,
      systemPrompts: this.systemPrompts,
      claudeConfig: config.claude,
      env: this.queryEnv,
      createCanUseTool: (localId) =>
        createCanUseTool(this.approvalManager, localId),
      // 自己メンション応答のレート制限 (bot 全体のスライディングウィンドウ)。
      selfMentionLimiter: new SelfMentionRateLimiter(
        SELF_MENTION_RATE_LIMIT_MAX_COUNT,
        SELF_MENTION_RATE_LIMIT_WINDOW_MINUTES,
      ),
    });

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
    const ready = new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, async (c) => {
        log.info(`logged in as ${c.user.tag}`);
        await this.registerCommands();

        // cron 初期化。
        this.cronExecutor = new CronExecutor({
          ports: createDiscordCronPorts({
            client: this.client,
            guildId: this.config.discord.guildId,
            approvalManager: this.approvalManager,
          }),
          config: this.config.claude,
          env: this.queryEnv,
          store: this.store,
          defaults: this.config.claude.defaults,
          systemPrompts: this.systemPrompts,
        });

        const cronJobs = await loadCronJobsFromDir(this.config.claude.cwd);
        this.cronExecutor.start(cronJobs);

        const reloadJobs = async () => {
          const jobs = await loadCronJobsFromDir(this.config.claude.cwd);
          this.cronExecutor!.reload(jobs);
        };

        // once ジョブのコールバック: ファイル削除 → reload
        this.cronExecutor.setOnceCallback(async (jobName: string) => {
          const filePath = join(this.config.claude.cwd, "cron", jobName);
          try {
            await rm(filePath);
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
          return await this.cronExecutor!.runJob(job);
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
        const healthCtx: HealthRouteContext = {
          // Client#isReady() は ws.status (WebSocketManager 全体の状態) を見るが、
          // 一度 Ready になった後は Gateway が切断されても Status.Ready のまま
          // 戻らない (discord.js の WebSocketManager#status は constructor と
          // triggerClientReady() でしか代入されない)。切断はシャード単位の
          // ws.shards の各 status にしか反映されないため、ここでは全シャードの
          // status が Status.Ready かどうかで判定する。
          isReady: () =>
            this.client.ws.shards.size > 0 &&
            this.client.ws.shards.every(
              (shard) => shard.status === Status.Ready,
            ),
        };
        try {
          this.apiServer = await startApiServer(
            this.config.claude.apiPort,
            settingsCtx,
            healthCtx,
            cronCtx,
          );
        } catch (e) {
          // ポート使用中などの listen 失敗は start() の例外として外へ出す。
          reject(e);
          return;
        }

        resolve();
      });
    });

    await this.client.login(this.config.discord.token);

    await ready;
  }

  /**
   * bot をシャットダウンする。
   *
   * HTTP サーバー停止 → Discord クライアント破棄 (await) の順で処理する。
   * 両ステップとも `SHUTDOWN_TIMEOUT_MS` (5 秒) で個別に打ち切り、超過時は
   * 警告ログを出して先へ進む (合計最大 10 秒)。`client.destroy()` の reject
   * も WARN ログに落として続行する。破棄後、呼び出し元 (main.ts) が
   * store.close() → process.exit() で明示的にプロセスを終了する (Store の
   * open / close は main.ts が対で所有する)。
   */
  async shutdown(): Promise<void> {
    log.info("shutting down");
    this.cronExecutor?.stop();

    const apiServer = this.apiServer;
    await withTimeout(
      apiServer
        ? new Promise<void>((resolve, reject) => {
            apiServer.close((e) => (e ? reject(e) : resolve()));
          }).catch((e) => log.warn("api server shutdown error:", e))
        : Promise.resolve(),
      SHUTDOWN_TIMEOUT_MS,
      "api server shutdown",
    );

    await withTimeout(
      this.client.destroy().catch((e) => log.warn("client destroy error:", e)),
      SHUTDOWN_TIMEOUT_MS,
      "client destroy",
    );

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
    // shouldRespond() は raw な parentId (親が無ければ null のまま) を要求する。
    // `message.channel.isThread()` は `this is ThreadChannel` の type guard で、
    // 判定結果を const に寄せても後続の parentId 参照は narrowing が効く
    // (TS の aliased condition narrowing)。テンプレート変数 (discord.channel.type)
    // にも使うため、resolveIncomingMessage() には渡しつつローカルにも残す。
    const isThread = message.channel.isThread();
    const parentId = isThread ? message.channel.parentId : null;

    // 認可 → 自己メンション判定 (+ レート制限) → スコープ抽出 → active 上書き
    // 取得 → 反応判定の一連の分岐は client/discord/incoming.ts に集約してある。discord.js
    // 依存部分 (mentions.has() / Store 読み取り / レート制限) は関数として注入する。
    const decision = await resolveIncomingMessage(
      {
        guildId: message.guildId,
        authorId: message.author.id,
        authorIsBot: message.author.bot,
        botUserId: this.client.user?.id ?? null,
        channel: message.channel,
        channelId: message.channelId,
        isThread,
        parentId,
        hasNonBotMentions: message.mentions.users.some((u) => !u.bot),
      },
      {
        config: this.config,
        // 自己メッセージでは本文中の `<@botId>` (parsedUsers 由来) だけを明示
        // メンションとみなす。`mentions.has()` の既定判定は bot 投稿への返信
        // ピング (gateway の mentions 配列に返信先が入る)・@everyone・bot が
        // 持つ role へのメンションでも true を返すため、呼び出し側
        // (resolveIncomingMessage) が渡す opts で除外する。
        isMentioned: (opts) =>
          this.client.user
            ? message.mentions.has(this.client.user, opts)
            : false,
        getActiveOverride: (scope) => this.store.getActive(scope),
        isSelfMentionRateLimited: () =>
          this.conversation.isSelfMentionExhausted(),
      },
    );

    if (decision.kind === "ignore") {
      if (decision.reason === "rate-limited") {
        log.warn(
          `self-mention rate limit exceeded, ignoring message in ${message.channelId}`,
        );
      }
      return;
    }

    // 承認ボタン・systemPrompt 解決・テンプレート変数は「発話があった場所」を見せたい。
    // スレッド内ならスレッド ID、通常チャンネルなら channel ID。
    const { scope, localId, isSelfMessage } = decision;

    // cleanContent は `<@botId>` を guild ニックネーム優先の表示名 (`@Nick`) に
    // 展開するため、グローバル表示名とニックネームの両方を除去対象に渡す。
    const prompt = stripBotMentions(message.cleanContent, [
      this.client.user?.displayName ?? "",
      message.guild?.members.me?.displayName ?? "",
    ]);

    const hasAttachments = message.attachments.size > 0;

    // テキストも添付もなければ無視
    if (!prompt && !hasAttachments) {
      return;
    }

    const channel = message.channel as GuildTextBasedChannel;

    // 自己メンションのレート枠の事前判定 (isExhausted) は resolveIncomingMessage()
    // 内で行い済み (枠の予約はせず、消費は query 実行直前の tryConsume で行うため、
    // busy なスコープに複数の自己メンションが積まれた場合は実行時に改めて弾かれる)。

    // テンプレート変数の発話者。自己メンション起動時の message.author は自 bot
    // だが、そのまま渡すと「発話者へメンションせよ」というプロンプト指示が
    // `<@botId>` を生み、自己メンションの再発火 (連鎖) につながる。自己起動時は
    // 認可ユーザー (本人) を発話者として渡す。
    const speakerId = isSelfMessage
      ? this.config.discord.userId
      : message.author.id;
    const speakerName = isSelfMessage
      ? (message.guild?.members.cache.get(speakerId)?.displayName ??
        this.client.users.cache.get(speakerId)?.displayName ??
        speakerId)
      : message.author.displayName;

    const templateVars: Record<string, string> = {
      "discord.guild.id": this.config.discord.guildId,
      "discord.guild.name": message.guild?.name ?? "",
      "discord.channel.id": localId,
      "discord.channel.name": "name" in channel ? (channel.name ?? "") : "",
      "discord.channel.type": isThread ? "thread" : "text",
      "discord.user.id": speakerId,
      "discord.user.name": speakerName,
    };

    await this.conversation.submit(
      { scope, localId, prompt, isSelfMessage, templateVars },
      this.createTurnOutput(message, channel, isSelfMessage, hasAttachments),
    );
  }

  /**
   * 1 ターン分の出力先 ({@link TurnOutput}) を Discord 向けに組み立てる。
   *
   * typing・進捗 reporter・ダウンロードした画像はターン単位の状態なので、
   * ターンごとにこの関数のクロージャで持つ。
   */
  private createTurnOutput(
    message: Message,
    channel: GuildTextBasedChannel,
    isSelfMessage: boolean,
    hasAttachments: boolean,
  ): TurnOutput {
    const typingController = new AbortController();
    let progress: ReturnType<typeof createProgressReporter> | undefined;
    let downloadedImages: DownloadedImage[] = [];
    let wasQueued = false;

    // 応答は発言者宛にする: 分割後のすべての投稿の先頭にメンションを付ける。
    // メンション分を引いた上限で分割してから各チャンク先頭に付与することで、
    // どのチャンクでも上限ぎりぎりでメンション分が溢れない（2000 字超過しない）。
    // 自己メッセージ起動時は空文字にする: 応答冒頭に自 bot メンションを付けると、
    // 応答自体が再度メンション条件を満たし連鎖の火種になるため。
    // 発話者 (認可ユーザー) へのピングは Client 既定の allowedMentions で通る。
    const mention = isSelfMessage ? "" : `<@${message.author.id}> `;
    const sendChunks = async (text: string): Promise<void> => {
      const chunks = splitMessage(text, DISCORD_MESSAGE_LIMIT - mention.length);
      for (const chunk of chunks) {
        await channel.send(mention + chunk);
      }
    };

    return {
      onQueued: () => {
        wasQueued = true;
        // 待機に入ったことを発言者へ可視化する。失敗は致命的でないので握り潰す。
        // react は fire-and-forget にして await しない (Conversation.submit の
        // isBusy 判定と enqueue の間に await を挟まないため)。
        message.react("⏳").catch(() => {});
      },

      onTurnStart: async () => {
        // 自分のターンが始まったら待機マーカー (⏳) を外す。
        if (wasQueued && this.client.user) {
          await message.reactions.cache
            .get("⏳")
            ?.users.remove(this.client.user.id)
            .catch(() => {});
        }

        // typing インジケーター開始
        keepTyping(channel, typingController.signal);

        progress = createProgressReporter(channel);
      },

      // 画像添付をダウンロード（画像フィルタは downloadImageAttachments 内で行う）
      preparePrompt: async (prompt) => {
        if (!hasAttachments) {
          return prompt;
        }
        downloadedImages = await downloadImageAttachments(
          message.attachments.values(),
        );
        if (downloadedImages.length > 0) {
          return appendImageReferences(
            prompt || "この画像について説明して",
            downloadedImages,
          );
        }
        return prompt;
      },

      sendReply: sendChunks,

      // thinking (推論) を引用形式で投稿する。回答ではないのでメンションは付けず、
      // Discord の `> ` 引用で回答と視覚的に分離する。
      sendThinking: async (text) => {
        const quoted = text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        for (const chunk of splitMessage(quoted)) {
          await channel.send(chunk);
        }
      },

      reportProgress: async (toolName, elapsedSeconds) => {
        await progress?.report(toolName, elapsedSeconds);
      },

      // エラーもまだ何も送っていなければ発言者宛にする（content 送出済みなら継続扱い）。
      // Discord へは要約のみ送り、全文はログ (GET /logs) を参照させる。
      notifyError: (error) => sendChunks(summarizeError(error)),

      onTurnEnd: async () => {
        if (downloadedImages.length > 0) {
          await cleanupImageFiles(downloadedImages);
        }
        await progress?.cleanup();
        typingController.abort();
      },
    };
  }
}
