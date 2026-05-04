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
import type { ScopeSettingEntry, Store, StoreScope } from "../store/mod.ts";
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
    startedAt: Temporal.Instant;
  },
): Promise<void> {
  const scope = scopeFromInteraction(interaction);
  const settings = await deps.store.getScopeSettings(scope);

  const lines: string[] = ["**loms-claw status**"];

  // uptime
  const uptimeMs = Temporal.Now.instant().since(deps.startedAt).total({
    unit: "millisecond",
  });
  lines.push(
    `**Uptime:** ${
      formatDuration(uptimeMs)
    } (started ${deps.startedAt.toString()})`,
  );

  // 現スコープ (channel + 必要なら thread)
  lines.push("");
  if (scope.threadId !== undefined) {
    lines.push(`**Thread:** ${scope.threadId} (parent: ${scope.channelId})`);
  } else {
    lines.push(`**Channel:** ${scope.channelId}`);
  }
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

  const scope = scopeFromInteraction(interaction);
  const scopeLabel = scope.threadId !== undefined ? "thread" : "channel";

  const updates: string[] = [];
  if (model) {
    await store.setModel(scope, model);
    updates.push(`model = \`${model}\``);
  }
  if (effort) {
    await store.setEffort(scope, effort);
    updates.push(`effort = \`${effort}\``);
  }
  await interaction.reply({
    content: `Updated for this ${scopeLabel}: ${updates.join(", ")}.`,
    flags: MessageFlags.Ephemeral,
  });
  log.info(
    `status set for ${scopeLabel} ${scope.threadId ?? scope.channelId}:`,
    updates.join(", "),
  );
}

/**
 * /claw status unset — チャンネル / スレッド単位の設定を削除する。
 *
 * 実行スコープはコマンドを叩いた場所で決まる:
 *   - スレッド内: そのスレッドの値のみ削除。親チャンネルの値は触らない。
 *     model / effort は channel → defaults へフォールバック、session は新規開始。
 *   - 通常チャンネル: そのチャンネルの値のみ削除。
 *
 * target:
 *   - "model"   → スコープの model を削除 (フォールバック先が新たな解決値)
 *   - "effort"  → スコープの effort を削除 (フォールバック先が新たな解決値)
 *   - "session" → スコープの session を削除 (会話を再開で新規セッション)
 */
export async function handleStatusUnset(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const target = interaction.options.getString("target", true);
  const scope = scopeFromInteraction(interaction);
  const scopeLabel = scope.threadId !== undefined ? "thread" : "channel";

  switch (target) {
    case "model":
      await store.deleteModel(scope);
      await interaction.reply({
        content: `Model unset for this ${scopeLabel} (fallback applies).`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "effort":
      await store.deleteEffort(scope);
      await interaction.reply({
        content: `Effort unset for this ${scopeLabel} (fallback applies).`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "session":
      await store.deleteSession(scope);
      await interaction.reply({
        content: `Session cleared for this ${scopeLabel}.`,
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
  log.info(
    `status unset ${target} for ${scopeLabel} ${
      scope.threadId ?? scope.channelId
    }`,
  );
}

function formatSetting(
  entry: ScopeSettingEntry | undefined,
): string {
  if (!entry) {
    return "(unset; CLI default applies)";
  }
  return `\`${entry.value}\` (${entry.source})`;
}

/**
 * インタラクションが起きた場所からスコープを抽出する。
 *
 * - スレッド内で実行: { channelId: parentId, threadId: thread.id }
 * - 通常チャンネルで実行: { channelId: channel.id }
 *
 * thread の parentId が null のケース (フォーラム親が消えた等の異常系) は
 * thread.id 自体を channelId にフォールバックさせ、Store の整合性を保つ。
 *
 * `channel?.isThread()` は `this is ThreadChannel` の TS type guard であり、
 * 真偽値変数経由では型ナローイングが効かないので呼び出し式のまま条件に使う。
 */
function scopeFromInteraction(
  interaction: ChatInputCommandInteraction,
): StoreScope {
  const channel = interaction.channel;
  if (channel?.isThread()) {
    return {
      channelId: channel.parentId ?? interaction.channelId,
      threadId: interaction.channelId,
    };
  }
  return { channelId: interaction.channelId };
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
