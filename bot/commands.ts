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
] as const;

const EFFORT_CHOICES = [
  { name: "low", value: "low" },
  { name: "medium", value: "medium" },
  { name: "high", value: "high" },
  { name: "xhigh", value: "xhigh" },
  { name: "max", value: "max" },
] as const;

const UNSET_TARGET_CHOICES = [
  { name: "model", value: "model" },
  { name: "effort", value: "effort" },
  { name: "session", value: "session" },
] as const;

/**
 * /claw コマンド定義。
 */
export const command = new SlashCommandBuilder()
  .setName("claw")
  .setDescription("loms-claw bot commands")
  .addSubcommandGroup((group) =>
    group
      .setName("status")
      .setDescription("Bot status (show / set / unset channel config)")
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription(
            "Show bot status (channel config, defaults, cron, VC, uptime)",
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription(
            "Set channel-level model / effort (specify at least one)",
          )
          .addStringOption((opt) =>
            opt
              .setName("model")
              .setDescription("Model alias for this channel")
              .setRequired(false)
              .addChoices(...MODEL_CHOICES)
          )
          .addStringOption((opt) =>
            opt
              .setName("effort")
              .setDescription("Effort level for this channel")
              .setRequired(false)
              .addChoices(...EFFORT_CHOICES)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("unset")
          .setDescription(
            "Clear channel-level setting (model / effort / session)",
          )
          .addStringOption((opt) =>
            opt
              .setName("target")
              .setDescription("Which setting to clear")
              .setRequired(true)
              .addChoices(...UNSET_TARGET_CHOICES)
          )
      )
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
  );

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
 * /claw status show — bot 全体のステータスを表示する。
 *
 * 含む情報:
 *   - 起動時刻 / uptime
 *   - 現チャンネルの session / model / effort (source 付き)
 *   - グローバルデフォルト (env)
 *   - cron ジョブ数 + 名前一覧
 *   - VC 接続状態 (有効時のみ)
 */
export async function handleStatusShow(
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

/**
 * /claw status set — チャンネル単位で model / effort を設定する。
 *
 * model と effort は両方 optional。少なくとも片方の指定が必須。
 * 両方指定した場合は同時に保存する。
 */
export async function handleStatusSet(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const model = interaction.options.getString("model");
  const effort = interaction.options.getString("effort");

  if (!model && !effort) {
    await interaction.reply({
      content: "Specify at least one of `model` or `effort`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const updates: string[] = [];
  if (model) {
    await store.setModel(interaction.channelId, model);
    updates.push(`model = \`${model}\``);
  }
  if (effort) {
    await store.setEffort(interaction.channelId, effort);
    updates.push(`effort = \`${effort}\``);
  }
  await interaction.reply({
    content: `Updated for this channel: ${updates.join(", ")}.`,
    flags: MessageFlags.Ephemeral,
  });
  log.info(
    `status set for channel ${interaction.channelId}:`,
    updates.join(", "),
  );
}

/**
 * /claw status unset — チャンネル単位の設定を削除する。
 *
 * target に指定したものをデフォルトに戻す:
 *   - "model"   → channel の model を削除 (env defaults にフォールバック)
 *   - "effort"  → channel の effort を削除 (env defaults にフォールバック)
 *   - "session" → 会話セッションを削除 (旧 /claw clear と同義)
 */
export async function handleStatusUnset(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const target = interaction.options.getString("target", true);
  const channelId = interaction.channelId;

  switch (target) {
    case "model":
      await store.deleteModel(channelId);
      await interaction.reply({
        content: "Model unset for this channel (default applies).",
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "effort":
      await store.deleteEffort(channelId);
      await interaction.reply({
        content: "Effort unset for this channel (default applies).",
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "session":
      await store.deleteSession(channelId);
      await interaction.reply({
        content: "Session cleared for this channel.",
        flags: MessageFlags.Ephemeral,
      });
      break;
    default:
      await interaction.reply({
        content: `Unknown target: ${target}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
  }
  log.info(`status unset ${target} for channel ${channelId}`);
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
