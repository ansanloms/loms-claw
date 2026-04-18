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
import type { Config } from "../config.ts";
import { askClaude } from "../claude/mod.ts";
import type { Store } from "../store/mod.ts";
import { ApprovalManager } from "../approval/manager.ts";
import { command } from "./commands.ts";
import { isAuthorized, shouldRespond } from "./guard.ts";
import {
  appendImageReferences,
  cleanupImageFiles,
  createProgressReporter,
  type DownloadedImage,
  downloadImageAttachments,
  keepTyping,
  splitMessage,
} from "./message.ts";
import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";
import { SystemPromptStore } from "../claude/system-prompt.ts";
import {
  handleClear,
  handleConfigEffort,
  handleConfigModel,
  handleConfigShow,
  handleStatus,
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
  private startedAt: Date = new Date();

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
        baseUrl: config.voice.whisperUrl,
        noSpeechProbThreshold: config.voice.noSpeechProbThreshold,
      });
      const tts = new OpenAiTts({
        baseUrl: config.voice.ttsUrl,
        apiKey: config.voice.ttsApiKey,
        model: config.voice.ttsModel,
        voice: config.voice.ttsSpeaker,
        speed: config.voice.ttsSpeed,
      });
      const voicePlayer = new VoicePlayer(tts, config.voice.notificationTone);

      this.voiceManager = new VoiceManager(
        config.voice,
        config.claude,
        config.guildId,
        config.authorizedUserId,
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

    await this.client.login(this.config.discordToken);

    await new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, async (c) => {
        log.info(`logged in as ${c.user.tag}`);
        await this.registerCommands();

        // cron 初期化。
        this.cronExecutor = new CronExecutor(
          this.client,
          this.config.claude,
          this.config.guildId,
          this.store,
          this.config.defaults,
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

        // 統合 API サーバーを起動する（承認フック + Discord REST API + cron）。
        const discordCtx = {
          client: this.client,
          guildId: this.config.guildId,
        };
        const cronCtx: CronRouteContext = {
          reloadCronJobs: reloadJobs,
          runJob: runJobByName,
          listJobs: () => this.cronExecutor!.listJobs(),
        };
        this.apiServer = startApiServer(
          this.approvalManager,
          discordCtx,
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
    const rest = new REST().setToken(this.config.discordToken);

    await rest.put(
      Routes.applicationGuildCommands(
        this.client.user!.id,
        this.config.guildId,
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
        const msg = error instanceof Error ? error.message : String(error);
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

    // /claw config <sub>
    if (group === "config") {
      if (sub === "show") {
        return handleConfigShow(interaction, this.store);
      }
      if (sub === "model") {
        return handleConfigModel(interaction, this.store);
      }
      if (sub === "effort") {
        return handleConfigEffort(interaction, this.store);
      }
      return;
    }

    // /claw clear
    if (sub === "clear") {
      return handleClear(interaction, this.store);
    }

    // /claw status
    if (sub === "status") {
      return handleStatus(interaction, {
        store: this.store,
        defaults: this.config.defaults,
        cronExecutor: this.cronExecutor,
        voiceManager: this.voiceManager,
        startedAt: this.startedAt,
      });
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
        this.config.activeChannelIds,
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
    const channelId = message.channelId;

    // typing インジケーター開始
    const typingController = new AbortController();
    keepTyping(channel, typingController.signal);

    const progress = createProgressReporter(channel);
    let downloadedImages: DownloadedImage[] = [];

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

      const [sessionId, model, effort] = await Promise.all([
        this.store.getSession(channelId),
        this.store.getModel(channelId),
        this.store.getEffort(channelId),
      ]);

      // 承認ボタンの送信先チャンネルを設定
      this.approvalManager.setChannel(channelId);

      const templateVars: Record<string, string> = {
        "discord.guild.id": this.config.guildId,
        "discord.guild.name": message.guild?.name ?? "",
        "discord.channel.id": channelId,
        "discord.channel.name": "name" in channel ? channel.name ?? "" : "",
        "discord.channel.type": "text",
        "discord.user.id": message.author.id,
        "discord.user.name": message.author.displayName,
      };

      const appendSystemPrompt = this.systemPrompts.resolve(
        "chat",
        channelId,
        templateVars,
      );

      const stream = askClaude(prompt, {
        sessionId,
        config: this.config.claude,
        signal: AbortSignal.timeout(this.config.claude.timeout),
        appendSystemPrompt,
        model,
        effort,
      });

      // ストリーミング応答: text_delta をバッファに蓄積し、
      // 閾値を超えたら文境界で区切って中間投稿する。
      const FLUSH_THRESHOLD = 800;
      let textBuffer = "";
      let hasStreamedText = false;
      let hasResult = false;
      // deno-lint-ignore no-explicit-any
      let resultEvent: any;

      const flushBuffer = async (force: boolean) => {
        if (force) {
          // 残り全部を投稿。
          const text = textBuffer.trim();
          textBuffer = "";
          if (text) {
            hasStreamedText = true;
            for (const chunk of splitMessage(text)) {
              await channel.send(chunk);
            }
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
        for (const chunk of splitMessage(send)) {
          await channel.send(chunk);
        }
      };

      for await (const event of stream) {
        if (
          event.type === "stream_event" &&
          !event.parent_tool_use_id
        ) {
          const e = event.event;
          if (
            e.type === "content_block_delta" &&
            "text" in e.delta &&
            e.delta.type === "text_delta"
          ) {
            textBuffer += e.delta.text;
            if (textBuffer.length >= FLUSH_THRESHOLD) {
              await flushBuffer(false);
            }
          }
        } else if (event.type === "result") {
          hasResult = true;
          resultEvent = event;
          // 非 success の subtype (error_max_turns 等) は Docker logs から原因を追えるよう詳細を残す。
          if (event.subtype !== "success") {
            log.warn(
              `claude returned non-success subtype "${event.subtype}":`,
              JSON.stringify(event),
            );
          }
          // 非ゼロ終了でジェネレータがスローしてもセッションが残るよう即座に保存
          await this.store.setSession(channelId, event.session_id);
        } else if (event.type === "tool_progress") {
          await progress.report(event.tool_name, event.elapsed_time_seconds);
        }
      }

      // バッファに残ったテキストを投稿。
      await flushBuffer(true);

      // stream_event がなかった場合は result.result からフォールバック。
      if (!hasStreamedText) {
        if (!hasResult) {
          throw new Error("claude stream ended without result event");
        }
        if (typeof resultEvent.result === "string") {
          for (const chunk of splitMessage(resultEvent.result)) {
            await channel.send(chunk);
          }
        } else {
          const errorDetail = resultEvent.errors
            ? JSON.stringify(resultEvent.errors)
            : resultEvent.subtype ?? "unknown error";
          throw new Error(`claude returned error: ${errorDetail}`);
        }
      }
    } catch (error: unknown) {
      // logger は Error の stack を自動で展開する。
      log.error("failed to process message:", error);
      const errMsg = error instanceof Error ? error.message : String(error);
      await channel.send(`Error: ${errMsg}`).catch(() => {});
    } finally {
      if (downloadedImages.length > 0) {
        await cleanupImageFiles(downloadedImages);
      }
      await progress.cleanup();
      typingController.abort();
    }
  }
}
