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
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { askClaude } from "../claude/mod.ts";
import { SessionStore } from "../session/mod.ts";
import { ApprovalManager } from "../approval/manager.ts";
import { startApprovalServer } from "../approval/server.ts";
import { command } from "./commands.ts";
import { isAuthorized, shouldRespond } from "./guard.ts";
import { createProgressReporter, keepTyping, splitMessage } from "./message.ts";
import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";
import { SystemPromptStore } from "../claude/system-prompt.ts";
import { handleClear, handleVcJoin, handleVcLeave } from "./commands.ts";
import { VoiceManager } from "../voice/mod.ts";
import { WhisperStt } from "../voice/stt.ts";
import { OpenAiTts } from "../voice/tts.ts";
import { VoicePlayer } from "../voice/player.ts";
import { startMcpServer } from "../mcp/server.ts";

const log = createLogger("bot");

/**
 * Discord ボット。
 */
export class DiscordBot {
  private client: Client;
  private config: Config;
  private sessions = new SessionStore();
  private approvalManager: ApprovalManager;
  private approvalServer: Deno.HttpServer | null = null;
  private mcpServer: Deno.HttpServer | null = null;
  private voiceManager: VoiceManager | null = null;
  private systemPrompts: SystemPromptStore;

  constructor(config: Config) {
    this.config = config;
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
    this.approvalManager = new ApprovalManager(this.client);

    // ボイス機能の初期化。
    if (config.voice.enabled) {
      const stt = new WhisperStt({ baseUrl: config.voice.whisperUrl });
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
        this.sessions,
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

    this.approvalServer = startApprovalServer(
      this.approvalManager,
      this.config.claude.approvalPort,
    );

    await this.client.login(this.config.discordToken);

    await new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, async (c) => {
        log.info(`logged in as ${c.user.tag}`);
        await this.registerCommands();

        // MCP サーバーを起動し .mcp.json を生成する。
        this.mcpServer = startMcpServer(
          { client: this.client, guildId: this.config.guildId },
          this.config.claude.mcpPort,
        );
        this.writeMcpConfig();

        // 起動時に auto-join 条件を満たす VC があれば参加する。
        this.voiceManager?.scanAndAutoJoin();
        resolve();
      });
    });
  }

  /**
   * bot をシャットダウンする。
   */
  shutdown(): void {
    log.info("shutting down");
    this.voiceManager?.shutdown();
    this.mcpServer?.shutdown();
    this.approvalServer?.shutdown();
    this.client.destroy();
  }

  /**
   * .mcp.json をワークスペースに書き出す。
   * claude -p が自動的に読み込み、MCP サーバーに接続する。
   */
  private writeMcpConfig(): void {
    const mcpConfigPath = join(this.config.claude.cwd, ".mcp.json");
    const config = {
      mcpServers: {
        discord: {
          type: "http",
          url: `http://127.0.0.1:${this.config.claude.mcpPort}/mcp`,
        },
      },
    };
    Deno.writeTextFileSync(mcpConfigPath, JSON.stringify(config, null, 2));
    log.info("wrote MCP config to", mcpConfigPath);
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
      await this.approvalManager.handleButton(interaction);
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

    // /claw clear
    if (sub === "clear") {
      return handleClear(interaction, this.sessions);
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
    if (
      !shouldRespond(
        message.channelId,
        this.config.activeChannelIds,
        message.channel.isThread(),
        message.channel.isThread() ? message.channel.parentId : null,
        isMentioned,
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
    if (!prompt) {
      return;
    }

    const channel = message.channel as GuildTextBasedChannel;
    const channelId = message.channelId;

    // typing インジケーター開始
    const typingController = new AbortController();
    keepTyping(channel, typingController.signal);

    const progress = createProgressReporter(channel);

    try {
      const sessionId = this.sessions.get(channelId);

      // 承認ボタンの送信先チャンネルを設定
      this.approvalManager.setChannel(channelId);

      const appendSystemPrompt = this.systemPrompts.resolve(
        "chat",
        channelId,
      );

      const stream = askClaude(prompt, {
        sessionId,
        config: this.config.claude,
        signal: AbortSignal.timeout(this.config.claude.timeout),
        appendSystemPrompt,
      });

      let resultEvent: SDKResultMessage | undefined;

      for await (const event of stream) {
        if (event.type === "result") {
          resultEvent = event;
          // 非ゼロ終了でジェネレータがスローしてもセッションが残るよう即座に保存
          this.sessions.set(channelId, event.session_id);
        } else if (event.type === "tool_progress") {
          await progress.report(event.tool_name, event.elapsed_time_seconds);
        }
      }

      if (!resultEvent) {
        throw new Error("claude stream ended without result event");
      }

      // 応答送信
      if ("result" in resultEvent && typeof resultEvent.result === "string") {
        const chunks = splitMessage(resultEvent.result);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
      } else {
        const errors = "errors" in resultEvent
          ? String(resultEvent.errors)
          : resultEvent.subtype;
        throw new Error(`claude returned error: ${errors}`);
      }
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("failed to process message:", errMsg);
      await channel.send(`Error: ${errMsg}`).catch(() => {});
    } finally {
      await progress.cleanup();
      typingController.abort();
    }
  }
}
