/**
 * スラッシュコマンドの定義とハンドラ実装。
 *
 * コマンド定義（SlashCommandBuilder）とハンドラ関数を同一ファイルに配置し、
 * コマンド追加時の変更箇所を 1 ファイルに集約する。
 * 各ハンドラはインタラクションの応答（reply/deferReply/editReply）まで責任を持つ。
 * bot/mod.ts はディスパッチのみを行い、ここに委譲する。
 */

import {
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { ClaudeDefaults } from "../config.ts";
import type { CronExecutor } from "../cron/executor.ts";
import type {
  ScopeSettingEntry,
  SettingsPatch,
  Store,
  StoreScope,
} from "../store/mod.ts";
import { createLogger } from "../logger.ts";
import { resolveActive } from "./guard.ts";

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
  { name: "show_thinking", value: "show_thinking" },
  { name: "active", value: "active" },
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
      .setName("settings")
      .setDescription("Channel settings (show / set / unset)")
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription(
            "Show channel settings (channel config, defaults, cron)",
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("set")
          .setDescription(
            "Set channel-level model / effort / show_thinking / active (specify at least one)",
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
          .addBooleanOption((opt) =>
            opt
              .setName("show_thinking")
              .setDescription("Show thinking (reasoning) in this channel")
              .setRequired(false)
          )
          .addBooleanOption((opt) =>
            opt
              .setName("active")
              .setDescription(
                "Respond to all messages in this channel (no mention required)",
              )
              .setRequired(false)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("unset")
          .setDescription(
            "Clear channel-level setting (model / effort / show_thinking / active / session)",
          )
          .addStringOption((opt) =>
            opt
              .setName("target")
              .setDescription("Which setting to clear")
              .setRequired(true)
              .addChoices(...UNSET_TARGET_CHOICES)
          )
      )
  );

/**
 * /claw settings show — bot 全体のステータスを表示する。
 *
 * 含む情報:
 *   - 現チャンネルの session / model / effort / active (source 付き)
 *   - グローバルデフォルト (config.json の claude.defaults)
 *   - cron ジョブ数 + 名前一覧
 */
export async function handleSettingsShow(
  interaction: ChatInputCommandInteraction,
  deps: {
    store: Store;
    defaults: ClaudeDefaults;
    cronExecutor: CronExecutor | null;
    activeChannelIds: string[];
  },
): Promise<void> {
  const scope = scopeFromInteraction(interaction);
  const settings = await deps.store.getScopeSettings(scope);

  const lines: string[] = ["**loms-claw settings**"];

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
  lines.push(
    `- show_thinking: \`${settings.showThinking.value}\` (${settings.showThinking.source})`,
  );

  // active: 実効値 (今そのチャンネルが全拾いかどうか) と出所を出す。
  const isThread = scope.threadId !== undefined;
  const effectiveActive = resolveActive(
    scope.threadId ?? scope.channelId,
    deps.activeChannelIds,
    isThread,
    isThread ? scope.channelId : null,
    settings.active?.value,
  );
  const activeSource = settings.active?.source ?? "config activeChannelIds";
  lines.push(`- active: \`${effectiveActive}\` (${activeSource})`);

  // グローバルデフォルト
  lines.push("");
  lines.push("**Defaults (config.json claude.defaults):**");
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
  lines.push(`- show_thinking: \`${deps.defaults.showThinking ?? false}\``);

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

  await interaction.reply({
    content: lines.join("\n"),
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * /claw settings set — チャンネル単位で model / effort / show_thinking / active を設定する。
 *
 * 4 項目はすべて optional。model / effort / show_thinking / active の少なくとも 1 つの指定が必須。
 * 複数指定した場合は同時に保存する。
 */
export async function handleSettingsSet(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const model = interaction.options.getString("model");
  const effort = interaction.options.getString("effort");
  const showThinking = interaction.options.getBoolean("show_thinking");
  const active = interaction.options.getBoolean("active");

  if (!model && !effort && showThinking === null && active === null) {
    await interaction.reply({
      content:
        "Specify at least one of `model` / `effort` / `show_thinking` / `active`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const scope = scopeFromInteraction(interaction);
  const scopeLabel = scope.threadId !== undefined ? "thread" : "channel";

  const patch: SettingsPatch = {};
  const updates: string[] = [];
  if (model) {
    patch.model = model;
    updates.push(`model = \`${model}\``);
  }
  if (effort) {
    patch.effort = effort;
    updates.push(`effort = \`${effort}\``);
  }
  if (showThinking !== null) {
    patch.showThinking = showThinking;
    updates.push(`show_thinking = \`${showThinking}\``);
  }
  if (active !== null) {
    patch.active = active;
    updates.push(`active = \`${active}\``);
  }
  await store.applyPatch(scope, patch);
  await interaction.reply({
    content: `Updated for this ${scopeLabel}: ${updates.join(", ")}.`,
    flags: MessageFlags.Ephemeral,
  });
  log.info(
    `settings set for ${scopeLabel} ${scope.threadId ?? scope.channelId}:`,
    updates.join(", "),
  );
}

/**
 * /claw settings unset — チャンネル / スレッド単位の設定を削除する。
 *
 * 実行スコープはコマンドを叩いた場所で決まる:
 *   - スレッド内: そのスレッドの値のみ削除。親チャンネルの値は触らない。
 *     model / effort / show_thinking は channel → defaults へフォールバック、session は新規開始。
 *   - 通常チャンネル: そのチャンネルの値のみ削除。
 *
 * target:
 *   - "model"         → スコープの model を削除 (フォールバック先が新たな解決値)
 *   - "effort"        → スコープの effort を削除 (フォールバック先が新たな解決値)
 *   - "show_thinking" → スコープの show_thinking を削除 (フォールバック先が新たな解決値)
 *   - "active"        → スコープの active を削除 (config の activeChannelIds へフォールバック)
 *   - "session"       → スコープの session を削除 (会話を再開で新規セッション)
 */
export async function handleSettingsUnset(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const target = interaction.options.getString("target", true);
  const scope = scopeFromInteraction(interaction);
  const scopeLabel = scope.threadId !== undefined ? "thread" : "channel";

  switch (target) {
    case "model":
      await store.applyPatch(scope, { model: null });
      await interaction.reply({
        content: `Model unset for this ${scopeLabel} (fallback applies).`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "effort":
      await store.applyPatch(scope, { effort: null });
      await interaction.reply({
        content: `Effort unset for this ${scopeLabel} (fallback applies).`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "show_thinking":
      await store.applyPatch(scope, { showThinking: null });
      await interaction.reply({
        content:
          `Show_thinking unset for this ${scopeLabel} (fallback applies).`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "active":
      await store.applyPatch(scope, { active: null });
      await interaction.reply({
        content:
          `Active unset for this ${scopeLabel} (config activeChannelIds applies).`,
        flags: MessageFlags.Ephemeral,
      });
      break;
    case "session":
      await store.applyPatch(scope, { session: null });
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
    `settings unset ${target} for ${scopeLabel} ${
      scope.threadId ?? scope.channelId
    }`,
  );
}

function formatSetting(
  entry: ScopeSettingEntry | undefined,
): string {
  if (!entry) {
    return "(unset; SDK default applies)";
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
