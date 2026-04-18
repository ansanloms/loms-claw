/**
 * スラッシュコマンドの定義とハンドラ実装。
 *
 * コマンド定義（SlashCommandBuilder）とハンドラ関数を同一ファイルに配置し、
 * コマンド追加時の変更箇所を 1 ファイルに集約する。
 * 各ハンドラはインタラクションの応答（reply/deferReply/editReply）まで責任を持つ。
 * bot/mod.ts はディスパッチのみを行い、ここに委譲する。
 */

import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { ClaudeDefaults } from "../config.ts";
import type { CronExecutor } from "../cron/executor.ts";
import type { Store } from "../store/mod.ts";
import type { VoiceManager } from "../voice/mod.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("commands");

const MODEL_CHOICES = [
  { name: "opus", value: "opus" },
  { name: "sonnet", value: "sonnet" },
  { name: "haiku", value: "haiku" },
  { name: "reset", value: "reset" },
] as const;

const EFFORT_CHOICES = [
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "xhigh", value: "xhigh" },
  { name: "max", value: "max" },
  { name: "reset", value: "reset" },
] as const;

/**
 * /claw コマンド定義。
 */
export const command = new SlashCommandBuilder()
  .setName("claw")
  .setDescription("loms-claw bot commands")
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription(
        "Show bot status (channel config, defaults, cron, VC, uptime)",
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("Clear the conversation session for this channel")
  )
  .addSubcommandGroup((group) =>
    group
      .setName("vc")
      .setDescription("Voice channel operations")
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("Join the voice channel")
      )
      .addSubcommand((sub) =>
        sub
          .setName("leave")
          .setDescription("Leave the voice channel")
      )
  )
  .addSubcommandGroup((group) =>
    group
      .setName("config")
      .setDescription("Per-channel model / effort configuration")
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription("Show current channel config (with defaults)")
      )
      .addSubcommand((sub) =>
        sub
          .setName("model")
          .setDescription("Set or reset model for this channel")
          .addStringOption((opt) =>
            opt
              .setName("value")
              .setDescription(
                "Model alias (or 'reset' to fall back to default)",
              )
              .setRequired(true)
              .addChoices(...MODEL_CHOICES)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("effort")
          .setDescription("Set or reset effort level for this channel")
          .addStringOption((opt) =>
            opt
              .setName("value")
              .setDescription(
                "Effort level (or 'reset' to fall back to default)",
              )
              .setRequired(true)
              .addChoices(...EFFORT_CHOICES)
          )
      )
  );

/**
 * /claw clear — 現在のチャンネルのセッションをクリアする。
 *
 * model / effort は触らず session のみ削除する。
 * model / effort は `/claw config <kind> reset` で個別に削除する。
 */
export async function handleClear(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  await store.deleteSession(interaction.channelId);
  await interaction.reply({
    content: "Session cleared.",
    flags: MessageFlags.Ephemeral,
  });
  log.info("session cleared for channel:", interaction.channelId);
}

/**
 * /claw vc join — ユーザーが居る VC に参加する。
 */
export async function handleVcJoin(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
): Promise<void> {
  if (interaction.channel?.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "Please run this from a VC text chat.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await voiceManager.join(interaction.channelId);
    await interaction.editReply("Joined VC.");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("failed to join VC:", msg);
    await interaction.editReply(`Failed to join VC: ${msg}`);
  }
}

/**
 * /claw vc leave — 現在の VC から離脱する。
 */
export async function handleVcLeave(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
): Promise<void> {
  const isVoiceChannel = interaction.channel?.type === ChannelType.GuildVoice;
  if (
    !isVoiceChannel ||
    interaction.channelId !== voiceManager.getCurrentChannelId()
  ) {
    await interaction.reply({
      content: "Please run this from the text chat of the VC I'm in.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  voiceManager.leave();
  await interaction.reply("Left VC.");
}

/**
 * /claw config show — 現在のチャンネル設定を表示する。
 */
export async function handleConfigShow(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const settings = await store.getChannelSettings(interaction.channelId);
  const lines: string[] = [`**Channel:** ${interaction.channelId}`];

  if (settings.session) {
    lines.push(`**Session:** \`${settings.session}\``);
  } else {
    lines.push("**Session:** (none)");
  }

  if (settings.model) {
    const tag = settings.model.source === "channel" ? "channel" : "default";
    lines.push(`**Model:** \`${settings.model.value}\` (${tag})`);
  } else {
    lines.push("**Model:** (unset; CLI default applies)");
  }

  if (settings.effort) {
    const tag = settings.effort.source === "channel" ? "channel" : "default";
    lines.push(`**Effort:** \`${settings.effort.value}\` (${tag})`);
  } else {
    lines.push("**Effort:** (unset; CLI default applies)");
  }

  await interaction.reply({
    content: lines.join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * /claw config model — モデルを設定または reset する。
 */
export async function handleConfigModel(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const value = interaction.options.getString("value", true);
  if (value === "reset") {
    await store.deleteModel(interaction.channelId);
    await interaction.reply({
      content: "Model reset for this channel (default applies).",
      flags: MessageFlags.Ephemeral,
    });
    log.info("model reset for channel:", interaction.channelId);
    return;
  }
  await store.setModel(interaction.channelId, value);
  await interaction.reply({
    content: `Model set to \`${value}\` for this channel.`,
    flags: MessageFlags.Ephemeral,
  });
  log.info(`model set for channel ${interaction.channelId}:`, value);
}

/**
 * /claw config effort — effort level を設定または reset する。
 */
export async function handleConfigEffort(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const value = interaction.options.getString("value", true);
  if (value === "reset") {
    await store.deleteEffort(interaction.channelId);
    await interaction.reply({
      content: "Effort reset for this channel (default applies).",
      flags: MessageFlags.Ephemeral,
    });
    log.info("effort reset for channel:", interaction.channelId);
    return;
  }
  await store.setEffort(interaction.channelId, value);
  await interaction.reply({
    content: `Effort set to \`${value}\` for this channel.`,
    flags: MessageFlags.Ephemeral,
  });
  log.info(`effort set for channel ${interaction.channelId}:`, value);
}

/**
 * /claw status — bot 全体のステータスを表示する。
 *
 * 含む情報:
 *   - 起動時刻 / uptime
 *   - 現チャンネルの session / model / effort (source 付き)
 *   - グローバルデフォルト (env)
 *   - cron ジョブ数 + 名前一覧
 *   - VC 接続状態 (有効時のみ)
 */
export async function handleStatus(
  interaction: ChatInputCommandInteraction,
  deps: {
    store: Store;
    defaults: ClaudeDefaults;
    cronExecutor: CronExecutor | null;
    voiceManager: VoiceManager | null;
    startedAt: Date;
  },
): Promise<void> {
  const settings = await deps.store.getChannelSettings(interaction.channelId);

  const lines: string[] = ["**loms-claw status**"];

  // uptime
  const uptimeMs = Date.now() - deps.startedAt.getTime();
  lines.push(
    `**Uptime:** ${
      formatDuration(uptimeMs)
    } (started ${deps.startedAt.toISOString()})`,
  );

  // 現チャンネル
  lines.push("");
  lines.push(`**Channel:** ${interaction.channelId}`);
  lines.push(
    `- session: ${settings.session ? `\`${settings.session}\`` : "(none)"}`,
  );
  lines.push(`- model: ${formatSetting(settings.model)}`);
  lines.push(`- effort: ${formatSetting(settings.effort)}`);

  // グローバルデフォルト
  lines.push("");
  lines.push("**Defaults (env):**");
  lines.push(
    `- model: ${
      deps.defaults.model ? `\`${deps.defaults.model}\`` : "(unset)"
    }`,
  );
  lines.push(
    `- effort: ${
      deps.defaults.effort ? `\`${deps.defaults.effort}\`` : "(unset)"
    }`,
  );

  // cron
  lines.push("");
  if (deps.cronExecutor) {
    const jobs = deps.cronExecutor.listJobs();
    if (jobs.length === 0) {
      lines.push("**Cron:** no jobs loaded");
    } else {
      lines.push(`**Cron:** ${jobs.length} job(s)`);
      for (const job of jobs) {
        lines.push(`- \`${job.name}\` (${job.schedule})`);
      }
    }
  } else {
    lines.push("**Cron:** not initialized");
  }

  // VC
  if (deps.voiceManager) {
    lines.push("");
    const vcChannelId = deps.voiceManager.getCurrentChannelId();
    lines.push(
      `**Voice:** ${
        vcChannelId ? `connected to ${vcChannelId}` : "not connected"
      }`,
    );
  }

  await interaction.reply({
    content: lines.join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

function formatSetting(
  entry: { value: string; source: "channel" | "default" } | undefined,
): string {
  if (!entry) {
    return "(unset; CLI default applies)";
  }
  return `\`${entry.value}\` (${entry.source})`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);
  return parts.join(" ");
}
