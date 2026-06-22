/**
 * Discord ボットの本体。
 *
 * messageCreate イベントを受け取り、認可チェックと反応判定を行い、
 * Claude Code CLI を呼び出して応答を返す。
 * ボイスチャンネル機能が有効な場合は VoiceManager を統合する。
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
import { isAuthorized, shouldRespond } from "./guard.ts";
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
  handleStatusSet,
  handleStatusShow,
  handleStatusUnset,
  handleVcJoin,
  handleVcLeave,
} from "./commands.ts";
import { VoiceManager } from "../voice/mod.ts";
import { WhisperStt } from "../voice/stt.ts";
import { OpenAiTts } from "../voice/tts.ts";
import { VoicePlayer } from "../voice/player.ts";
import { startApiServer } from "../api/server.ts";
import type { CronRouteContext } from "../api/routes/cron.ts";
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
  private voiceManager: VoiceManager | null = null;
  private cronExecutor: CronExecutor | null = null;
  private systemPrompts: SystemPromptStore;
  private startedAt: Temporal.Instant = Temporal.Now.instant();
  /** scope (channel / thread) 単位でメッセージ処理を直列化するキュー。 */
  private chatQueue = new ScopeQueue();

  constructor(config: Config, store: Store) {
    this.config = config;
    this.store = store;
    this.systemPrompts = new SystemPromptStore(
      join(config.claude.cwd, ".claude", "system-prompt"),
    );
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        ...(config.voice.enabled ? [GatewayIntentBits.GuildVoiceStates] : []),
      ],
    });
    this.approvalManager = new ApprovalManager(
      this.client,
      join(config.claude.cwd, ".claude", "settings.json"),
    );

    // ボイス機能の初期化。
    if (config.voice.enabled) {
      const stt = new WhisperStt({
        baseUrl: config.voice.whisper.url,
        noSpeechProbThreshold: config.voice.whisper.noSpeechProbThreshold,
      });
      const tts = new OpenAiTts({
        baseUrl: config.voice.tts.url,
        apiKey: config.voice.tts.apiKey,
        model: config.voice.tts.model,
        voice: config.voice.tts.speaker,
        speed: config.voice.tts.speed,
      });
      const voicePlayer = new VoicePlayer(tts, config.voice.notificationTone);

      this.voiceManager = new VoiceManager(
        config.voice,
        config.claude,
        config.discord.guildId,
        config.discord.token,
        config.discord.userId,
        this.client,
        stt,
        voicePlayer,
        this.store,
        this.approvalManager,
        this.systemPrompts,
      );

      this.client.on(
        Events.VoiceStateUpdate,
        (oldState, newState) =>
          this.voiceManager?.onVoiceStateUpdate(oldState, newState),
      );
    }

    this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));
    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i));
  }

  /**
   * bot を起動する。Discord gateway に接続し、スラッシュコマンドを登録する。
   */
  async start(): Promise<void> {
    await this.systemPrompts.load();

    await this.client.login(this.config.discord.token);

    await new Promise<void>((resolve) => {
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

        // 統合 API サーバーを起動する（cron + ログ取得）。
        const cronCtx: CronRouteContext = {
          reloadCronJobs: reloadJobs,
          runJob: runJobByName,
          listJobs: () => this.cronExecutor!.listJobs(),
        };
        this.apiServer = startApiServer(
          this.config.claude.apiPort,
          cronCtx,
        );

        // 起動時に auto-join 条件を満たす VC があれば参加する。
        this.voiceManager?.scanAndAutoJoin();

        resolve();
      });
    });
  }

  /**
   * bot をシャットダウンする。
   *
   * VC 切断 → HTTP サーバー停止 → Discord クライアント破棄の順で処理し、
   * クライアント破棄によりイベントループが自然終了する。
   */
  shutdown(): void {
    log.info("shutting down");
    this.voiceManager?.shutdown();
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
   * スラッシュコマンドのハンドラ。
   */
  private async onInteraction(interaction: Interaction): Promise<void> {
    // ボタンインタラクション（承認/拒否）
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

    // /claw vc <sub>
    if (group === "vc") {
      if (!this.voiceManager) {
        await interaction.reply({
          content: "Voice feature is not enabled.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (sub === "join") {
        return handleVcJoin(interaction, this.voiceManager);
      }
      if (sub === "leave") {
        return handleVcLeave(interaction, this.voiceManager);
      }
      return;
    }

    // /claw status <sub>
    if (group === "status") {
      if (sub === "show") {
        return handleStatusShow(interaction, {
          store: this.store,
          defaults: this.config.claude.defaults,
          cronExecutor: this.cronExecutor,
          voiceManager: this.voiceManager,
          startedAt: this.startedAt,
        });
      }
      if (sub === "set") {
        return handleStatusSet(interaction, this.store);
      }
      if (sub === "unset") {
        return handleStatusUnset(interaction, this.store);
      }
      return;
    }
  }

  /**
   * メッセージ受信時のメインハンドラ。
   */
  private async onMessage(message: Message): Promise<void> {
    // bot 自身のメッセージは無視
    if (message.author.id === this.client.user?.id) {
      return;
    }

    // 認可チェック
    if (
      !isAuthorized(
        message.guildId,
        message.author.id,
        message.author.bot,
        this.config,
      )
    ) {
      return;
    }

    // 反応判定
    const isMentioned = this.client.user
      ? message.mentions.has(this.client.user)
      : false;
    const hasNonBotMentions = message.mentions.users.some((u) => !u.bot);
    if (
      !shouldRespond(
        message.channelId,
        this.config.discord.activeChannelIds,
        message.channel.isThread(),
        message.channel.isThread() ? message.channel.parentId : null,
        isMentioned,
        hasNonBotMentions,
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

    const hasAttachments = message.attachments.size > 0;

    // テキストも添付もなければ無視
    if (!prompt && !hasAttachments) {
      return;
    }

    const channel = message.channel as GuildTextBasedChannel;
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
      const mention = `<@${message.author.id}> `;
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
