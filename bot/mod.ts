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
import { createLogger } from "../logger.ts";

const log = createLogger("bot");

/**
 * Discord ボット。
 */
export class DiscordBot {
  private client: Client;
  private config: Config;
  private sessions: SessionStore;
  private approvalManager: ApprovalManager;
  private approvalServer: Deno.HttpServer | null = null;

  constructor(config: Config) {
    this.config = config;
    this.sessions = new SessionStore(config.sessionFile);
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
    this.approvalManager = new ApprovalManager(this.client);

    this.client.on(Events.MessageCreate, (msg) => this.onMessage(msg));
    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i));
  }

  /**
   * bot を起動する。Discord gateway に接続し、スラッシュコマンドを登録する。
   */
  async start(): Promise<void> {
    this.approvalServer = startApprovalServer(
      this.approvalManager,
      this.config.claude.approvalPort,
    );

    await this.client.login(this.config.discordToken);

    await new Promise<void>((resolve) => {
      this.client.once(Events.ClientReady, async (c) => {
        log.info(`logged in as ${c.user.tag}`);
        await this.registerCommands();
        resolve();
      });
    });
  }

  /**
   * bot をシャットダウンする。
   */
  shutdown(): void {
    log.info("shutting down");
    this.approvalServer?.shutdown();
    this.client.destroy();
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

    const sub = interaction.options.getSubcommand();

    if (sub === "clear") {
      this.sessions.delete(interaction.channelId);
      await interaction.reply({
        content: "Session cleared.",
        ephemeral: true,
      });
      log.info("session cleared for channel:", interaction.channelId);
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

      const stream = askClaude(prompt, {
        sessionId,
        config: this.config.claude,
        signal: AbortSignal.timeout(this.config.claude.timeout),
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
