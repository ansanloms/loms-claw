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
  REST,
  Routes,
} from "discord.js";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.ts";
import {
  askClaude,
  extractResultText,
  extractTopLevelTextDelta,
  extractTopLevelThinkingDelta,
} from "../claude/mod.ts";
import type { Store, StoreScope } from "../store/mod.ts";
import { ApprovalManager, createCanUseTool } from "../approval/manager.ts";
import { command } from "./commands.ts";
import {
  isAuthorized,
  isAuthorizedSelfMessage,
  parseHopMarker,
  shouldRespond,
  shouldRespondToSelf,
} from "./guard.ts";
import { SelfMentionRateLimiter } from "./ratelimit.ts";
import { ScopeQueue } from "./queue.ts";
import {
  appendImageReferences,
  cleanupImageFiles,
  createProgressReporter,
  DISCORD_MESSAGE_LIMIT,
  type DownloadedImage,
  downloadImageAttachments,
  keepTyping,
  splitMessage,
} from "./message.ts";
import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";
import { SystemPromptStore } from "../claude/system-prompt.ts";
import {
  handleSettingsSet,
  handleSettingsShow,
  handleSettingsUnset,
} from "./commands.ts";
import { startApiServer } from "../api/server.ts";
import type { CronRouteContext } from "../api/routes/cron.ts";
import type { SettingsRouteContext } from "../api/routes/settings.ts";
import { CronExecutor } from "../cron/executor.ts";
import { loadCronJobsFromDir } from "../cron/loader.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("bot");

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
      config.discord.selfMention.rateLimit.maxCount,
      config.discord.selfMention.rateLimit.windowMinutes,
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
      // bot 自身の投稿本文に `<@botId>` と `[hop:N]` が紛れても自己メンション
      // 連鎖の発火条件を満たさないよう、送信時のメンション解決を既定で無効化
      // する。メンションが必要な送信箇所は per-send の allowedMentions で
      // 明示許可する（sendChunks の発話者宛てピング等）。
      allowedMentions: { parse: [] },
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
   * HTTP サーバー停止 → Discord クライアント破棄の順で処理し、
   * クライアント破棄によりイベントループが自然終了する。
   */
  shutdown(): void {
    log.info("shutting down");
    this.cronExecutor?.stop();
    // TODO: WebSocket/SSE 追加時は shutdown() を async にして await すること
    this.apiServer?.shutdown().catch((e) =>
      log.warn("api server shutdown error:", e)
    );
    this.client.destroy();
    this.store.close();
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
      try {
        await this.approvalManager.handleButton(interaction);
      } catch (error: unknown) {
        const msg = getErrorMessage(error);
        log.error("button interaction error:", msg);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "承認処理中にエラーが発生しました。",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
      }
      return;
    }

    // select メニュー（AskUserQuestion の回答）
    if (interaction.isStringSelectMenu()) {
      try {
        await this.approvalManager.handleSelect(interaction);
      } catch (error: unknown) {
        const msg = getErrorMessage(error);
        log.error("select interaction error:", msg);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "回答処理中にエラーが発生しました。",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
      }
      return;
    }

    // Modal 送信（AskUserQuestion の Other 自由入力）
    if (interaction.isModalSubmit()) {
      try {
        await this.approvalManager.handleModal(interaction);
      } catch (error: unknown) {
        const msg = getErrorMessage(error);
        log.error("modal interaction error:", msg);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: "回答処理中にエラーが発生しました。",
            flags: MessageFlags.Ephemeral,
          }).catch(() => {});
        }
      }
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
    // bot 自身のメッセージは、自己メンション機能が有効な場合のみ条件付きで処理する。
    // 他の bot / 他ユーザーは従来どおり isAuthorized() で判定する。
    const botUserId = this.client.user?.id ?? null;
    const isSelfMessage = botUserId !== null && message.author.id === botUserId;
    if (isSelfMessage) {
      if (
        !isAuthorizedSelfMessage(
          message.guildId,
          message.author.id,
          botUserId,
          this.config,
        )
      ) {
        return;
      }
    } else if (
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
    // `message.channel.isThread()` は `this is ThreadChannel` の type guard だが、
    // `message.channel` の型は元々 parentId を持つ型を含む union なので、
    // 判定結果を isThread 変数に寄せても後続の parentId 参照で型エラーにならない。
    const isThread = message.channel.isThread();
    const scope: StoreScope = {
      channelId: isThread
        ? (message.channel.parentId ?? message.channelId)
        : message.channelId,
      threadId: isThread ? message.channelId : undefined,
    };
    // 承認ボタン・systemPrompt 解決・テンプレート変数は「発話があった場所」を見せたい。
    // スレッド内ならスレッド ID、通常チャンネルなら channel ID。
    const localId = scope.threadId ?? scope.channelId;

    // 反応判定
    const isMentioned = this.client.user
      ? message.mentions.has(this.client.user)
      : false;
    const hasNonBotMentions = message.mentions.users.some((u) => !u.bot);
    const activeOverride = await this.store.getActive(scope);
    const hop = isSelfMessage ? parseHopMarker(message.content) : null;
    if (isSelfMessage) {
      const { maxHops } = this.config.discord.selfMention;
      if (!shouldRespondToSelf(isMentioned, hop, maxHops, activeOverride)) {
        return;
      }
      // 全チェック通過後にのみレート枠を消費する（拒否されるメッセージで枠を浪費しない）。
      if (!this.selfMentionLimiter.tryConsume()) {
        log.warn(
          `self-mention rate limit exceeded, ignoring message in ${message.channelId}`,
        );
        return;
      }
    } else if (
      !shouldRespond(
        message.channelId,
        this.config.discord.activeChannelIds,
        isThread,
        isThread ? message.channel.parentId : null,
        isMentioned,
        hasNonBotMentions,
        activeOverride,
      )
    ) {
      return;
    }

    let prompt = message.cleanContent;
    if (this.client.user) {
      prompt = prompt.replaceAll(
        `@${this.client.user.displayName}`,
        "",
      );
    }
    prompt = prompt.trim();

    // 自己メンション起動時は、連鎖の続け方（ホップ増分）と上限をプロンプトに明示する。
    // [hop:N] マーカー自体は cleanContent に残っているため、ここでは案内のみ追記する。
    if (isSelfMessage && hop !== null) {
      const { maxHops } = this.config.discord.selfMention;
      prompt +=
        `\n\n(AI to AI 連鎖: 現在 hop ${hop}/${maxHops}。さらに別チャンネル/スレッドへ依頼する場合は、送信メッセージに [hop:${
          hop + 1
        }] を含めること。上限に達している場合は新たな bot メンションを行わないこと。)`;
    }

    const hasAttachments = message.attachments.size > 0;

    // テキストも添付もなければ無視
    if (!prompt && !hasAttachments) {
      return;
    }

    const channel = message.channel as GuildTextBasedChannel;

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
      const mention = isSelfMessage ? "" : `<@${message.author.id}> `;
      const sendChunks = async (text: string): Promise<void> => {
        const chunks = splitMessage(
          text,
          DISCORD_MESSAGE_LIMIT - mention.length,
        );
        for (const chunk of chunks) {
          // 人間宛て応答 (mention が空でない) は発話者へのピングを維持する
          // 必要があるため、Client 既定の allowedMentions.parse:[] を per-send
          // で明示上書きする。自己メッセージ起動時 (mention === "") は
          // 既定の全抑制のままでよい。
          await (mention
            ? channel.send({
              content: mention + chunk,
              allowedMentions: { users: [message.author.id] },
            })
            : channel.send(mention + chunk));
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

        const [sessionId, model, effort, showThinking] = await Promise.all([
          this.store.getSession(scope),
          this.store.getModel(scope),
          this.store.getEffort(scope),
          this.store.getShowThinking(scope),
        ]);

        // 承認ボタンの送信先は発話があった場所 (スレッド優先)
        this.approvalManager.setChannel(localId);

        const templateVars: Record<string, string> = {
          "discord.guild.id": this.config.discord.guildId,
          "discord.guild.name": message.guild?.name ?? "",
          "discord.channel.id": localId,
          "discord.channel.name": "name" in channel ? channel.name ?? "" : "",
          "discord.channel.type": isThread ? "thread" : "text",
          "discord.user.id": message.author.id,
          "discord.user.name": message.author.displayName,
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
        const FLUSH_THRESHOLD = 800;
        let textBuffer = "";
        let hasStreamedText = false;
        let resultEvent: SDKResultMessage | undefined;

        const flushBuffer = async (force: boolean) => {
          if (force) {
            // 残り全部を投稿。
            const text = textBuffer.trim();
            textBuffer = "";
            if (text) {
              hasStreamedText = true;
              await sendChunks(text);
            }
            return;
          }
          // 最後の文境界（。、改行）で区切って投稿。
          const lastBoundary = Math.max(
            textBuffer.lastIndexOf("。"),
            textBuffer.lastIndexOf("\n"),
          );
          if (lastBoundary < 0) {
            // 境界が見つからないが閾値の 2 倍を超えたら強制フラッシュ。
            // コードブロック・英語テキスト・URL 等が連続するケースへの対策。
            if (textBuffer.length >= FLUSH_THRESHOLD * 2) {
              await flushBuffer(true);
            }
            return;
          }
          const send = textBuffer.slice(0, lastBoundary + 1).trim();
          textBuffer = textBuffer.slice(lastBoundary + 1);
          if (!send) {
            return;
          }
          hasStreamedText = true;
          await sendChunks(send);
        };

        // thinking 用バッファ。回答テキストとは独立に文境界でフラッシュする。
        // 回答より閾値を高めにして、推論の中間投稿で本文が埋もれないようにする。
        const THINKING_FLUSH_THRESHOLD = 1500;
        let thinkingBuffer = "";

        const flushThinking = async (force: boolean) => {
          if (force) {
            const text = thinkingBuffer.trim();
            thinkingBuffer = "";
            if (text) {
              await sendThinking(text);
            }
            return;
          }
          const lastBoundary = Math.max(
            thinkingBuffer.lastIndexOf("。"),
            thinkingBuffer.lastIndexOf("\n"),
          );
          if (lastBoundary < 0) {
            if (thinkingBuffer.length >= THINKING_FLUSH_THRESHOLD * 2) {
              await flushThinking(true);
            }
            return;
          }
          const send = thinkingBuffer.slice(0, lastBoundary + 1).trim();
          thinkingBuffer = thinkingBuffer.slice(lastBoundary + 1);
          if (send) {
            await sendThinking(send);
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
            if (event.subtype !== "success") {
              log.warn(
                `claude returned non-success subtype "${event.subtype}":`,
                JSON.stringify(event),
              );
            }
            // 非ゼロ終了でジェネレータがスローしてもセッションが残るよう即座に保存
            await this.store.setSession(scope, event.session_id);
          } else if (event.type === "tool_progress") {
            await progress.report(event.tool_name, event.elapsed_time_seconds);
          }
        }

        // バッファに残った thinking / テキストを投稿。
        await flushThinking(true);
        await flushBuffer(true);

        // stream_event がなかった場合は result.result からフォールバック。
        if (!hasStreamedText) {
          if (!resultEvent) {
            throw new Error("claude stream ended without result event");
          }
          await sendChunks(extractResultText(resultEvent));
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
