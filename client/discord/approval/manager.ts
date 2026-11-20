/**
 * Discord ボタンによるツール承認マネージャー。
 *
 * Agent SDK の `canUseTool` コールバックからツール情報を受け取り、
 * Discord にボタン付きメッセージを送信してユーザーの承認/拒否を待つ。
 */

import type {
  CanUseTool,
  PermissionBehavior,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  type GuildTextBasedChannel,
  MessageFlags,
} from "discord.js";
import { getErrorMessage } from "../../../errors.ts";
import { createLogger } from "../../../logger.ts";
import { DISCORD_MESSAGE_LIMIT } from "../message.ts";
import { INTERACTION_TIMEOUT_MS } from "./constants.ts";
import {
  appendStatus,
  neutralizeBackticks,
  parseQuestions,
  type Question,
  QuestionManager,
  type QuestionResult,
  truncate,
} from "./question.ts";
import {
  addToSettingsAllowList,
  isInAllowList,
} from "../../../core/approval-settings.ts";

const log = createLogger("approval");

/**
 * 本文の末尾に足す結果表示 (suffix)。文言はここに集め、余白 (`STATUS_RESERVE`) はその最長から導く。
 */
export const STATUS_SUFFIX = {
  allowed: "\n**→ Allowed**",
  alwaysAllowed: "\n**→ Always Allowed**",
  /** Allow Always の保存に失敗したが、承認は通した。 */
  notPersisted: "\n**→ Allowed (settings.json への保存に失敗)**",
  denied: "\n**→ Denied**",
  timedOut: "\n**→ Timed out**",
  aborted: "\n**→ Aborted**",
} as const;

/**
 * 本文に残す結果表示の余白。`STATUS_SUFFIX` の最長に合わせる。
 */
export const STATUS_RESERVE = Math.max(
  ...Object.values(STATUS_SUFFIX).map((suffix) => suffix.length),
);

/**
 * 承認結果。
 */
export interface ApprovalResult {
  decision: PermissionBehavior;
  reason?: string;
}

/**
 * 承認ボタン付きメッセージを送信できるチャンネル (テスト用に discord.js の
 * `GuildTextBasedChannel` から必要最小限を切り出したもの)。
 */
export interface ApprovalSendableChannel {
  send(payload: {
    content: string;
    components: ActionRowBuilder<ButtonBuilder>[];
  }): Promise<{
    content: string;
    edit(payload: { content: string; components: [] }): Promise<unknown>;
  }>;
}

/**
 * `requestApproval()` がチャンネル ID から送信先チャンネルを解決するためのインターフェース。
 *
 * 既定実装は discord.js の `Client` (`client.channels.fetch()`) から作るが、
 * テストでは fake を差し替えることで discord.js に触れずに `requestApproval()`
 * を検証できる。
 */
export interface ApprovalChannelResolver {
  /**
   * `channelId` から送信可能なチャンネルを解決する。
   * 見つからない、またはテキストベースでない場合は `null` を返す。
   */
  fetchSendable(channelId: string): Promise<ApprovalSendableChannel | null>;
}

/**
 * 実際の discord.js `Client` から {@link ApprovalChannelResolver} の既定実装を作る。
 */
function defaultChannelResolver(client: Client): ApprovalChannelResolver {
  return {
    async fetchSendable(channelId) {
      const channel = await client.channels.fetch(channelId);
      if (!channel?.isTextBased()) {
        return null;
      }
      return channel as GuildTextBasedChannel;
    },
  };
}

/**
 * 承認マネージャー。
 */
export class ApprovalManager {
  private pending = new Map<
    string,
    {
      resolve: (result: ApprovalResult) => void;
      timeout: ReturnType<typeof setTimeout>;
      /** abort listener の解除。解決時に呼ぶ。 */
      cleanup: () => void;
      /** Allow Always で allow list に足すツール名 (customId には載せない)。 */
      toolName: string;
    }
  >();
  private questions: QuestionManager;
  private channelResolver: ApprovalChannelResolver;
  private timeoutMs: number;
  private settingsPath: string;

  /**
   * @param client - discord.js Client。既定のチャンネル解決 (`channelResolver`
   *   未指定時) と `QuestionManager` の生成に使う。
   * @param settingsPath - `.claude/settings.json` の絶対パス。
   * @param options.channelResolver - 承認メッセージの送信先解決を差し替える
   *   場合に指定する (既定は `client` から作った discord.js 実装)。
   * @param options.timeoutMs - 承認待ちのタイムアウト (既定は
   *   `INTERACTION_TIMEOUT_MS`)。テストで短縮する用途。
   */
  constructor(
    client: Client,
    settingsPath: string,
    options?: {
      channelResolver?: ApprovalChannelResolver;
      timeoutMs?: number;
    },
  ) {
    this.settingsPath = settingsPath;
    this.questions = new QuestionManager(client);
    this.channelResolver =
      options?.channelResolver ?? defaultChannelResolver(client);
    this.timeoutMs = options?.timeoutMs ?? INTERACTION_TIMEOUT_MS;
  }

  /**
   * ツール使用の承認をリクエストする。
   *
   * @param toolName - 対象ツール名。
   * @param toolInput - ツールへの入力。承認ボタンの詳細表示に使う。
   * @param channelId - 承認ボタンの送信先チャンネル ID。呼び出し元が必須で渡す
   * (cron でジョブに channelId が無ければ undefined を渡す。undefined なら自動 deny)。
   * @param signal - ターンの中断シグナル。abort されたら承認待ちを打ち切る。
   */
  async requestApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    channelId: string | undefined,
    signal?: AbortSignal,
  ): Promise<ApprovalResult> {
    // allow list に含まれるツールは即座に許可する。
    if (await isInAllowList(this.settingsPath, toolName)) {
      log.info("approval resolved:", toolName, "Already Allowed");
      return { decision: "allow", reason: "Already Allowed" };
    }

    if (!channelId) {
      log.warn("no channel set for approval, auto-denying");
      return { decision: "deny", reason: "No approval channel" };
    }

    if (signal?.aborted) {
      return { decision: "deny", reason: "Aborted" };
    }

    let channel: ApprovalSendableChannel | null;
    try {
      channel = await this.channelResolver.fetchSendable(channelId);
    } catch (error: unknown) {
      log.warn(
        "failed to resolve approval channel:",
        channelId,
        getErrorMessage(error),
      );
      return { decision: "deny", reason: "Failed to resolve channel" };
    }
    if (!channel) {
      log.warn("approval channel not found:", channelId);
      return { decision: "deny", reason: "Channel not found" };
    }
    if (signal?.aborted) {
      return { decision: "deny", reason: "Aborted" };
    }

    const requestId = crypto.randomUUID().slice(0, 8);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${requestId}`)
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`always:${requestId}`)
        .setLabel("Allow Always")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`deny:${requestId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const description =
      typeof toolInput.description === "string"
        ? truncate(neutralizeBackticks(toolInput.description), 300)
        : "";
    // インラインコードを閉じさせないよう、ヘッダの表示だけバッククォートを `'` にする。
    // 置き換えた後は単独のバッククォートが残らないので neutralizeBackticks は要らない。
    // allowlist に保存する toolName と customId は元のまま。
    const displayToolName = toolName.replaceAll("`", "'");
    const header = [
      `**Tool: \`${truncate(displayToolName, 100)}\`**`,
      ...(description ? [description] : []),
    ].join("\n");
    // 閉じフェンスと結果表示 (appendStatus の最長 suffix) の分を空けて JSON ダンプを切る。
    const dumpBudget = Math.max(
      0,
      DISCORD_MESSAGE_LIMIT -
        STATUS_RESERVE -
        header.length -
        "\n```json\n\n```".length,
    );
    // 入力中の連続するバッククォートは、間にゼロ幅スペースを挟んでフェンスを閉じさせない。
    const inputDump = neutralizeBackticks(JSON.stringify(toolInput, null, 2));
    const truncated = truncate(inputDump, Math.min(1500, dumpBudget));
    const content = `${header}\n\`\`\`json\n${truncated}\n\`\`\``;

    let message: Awaited<ReturnType<ApprovalSendableChannel["send"]>>;
    try {
      message = await channel.send({ content, components: [row] });
    } catch (error: unknown) {
      log.warn("failed to post approval request:", getErrorMessage(error));
      return { decision: "deny", reason: "Failed to post approval request" };
    }

    log.info("approval requested:", requestId, toolName);

    const editStatus = (suffix: string, label: string) => {
      message
        .edit({
          content: appendStatus(message.content, suffix),
          components: [],
        })
        .catch((error: unknown) => {
          log.warn(`failed to edit ${label} message:`, getErrorMessage(error));
        });
    };

    // send の待機中に abort されると listener は発火しないので、ここで確かめる。
    if (signal?.aborted) {
      log.warn("approval aborted:", requestId);
      editStatus(STATUS_SUFFIX.aborted, "aborted");
      return { decision: "deny", reason: "Aborted" };
    }

    return new Promise<ApprovalResult>((resolve) => {
      const onAbort = () => {
        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        log.warn("approval aborted:", requestId);
        editStatus(STATUS_SUFFIX.aborted, "aborted");
        resolve({ decision: "deny", reason: "Aborted" });
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);

      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        cleanup();
        log.warn("approval timed out:", requestId);
        editStatus(STATUS_SUFFIX.timedOut, "timed out");
        resolve({ decision: "deny", reason: "Timed out" });
      }, this.timeoutMs);

      this.pending.set(requestId, { resolve, timeout, cleanup, toolName });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /**
   * AskUserQuestion の質問への回答をリクエストする。
   *
   * channelId は呼び出し元が必須で渡す (無ければ undefined)。
   * 質問メッセージの送信・回答収集は {@link QuestionManager} に委譲する。
   */
  requestAnswers(
    questions: Question[],
    channelId: string | undefined,
    signal?: AbortSignal,
  ): Promise<QuestionResult> {
    return this.questions.requestAnswers(questions, channelId, signal);
  }

  /**
   * 質問の select メニューのインタラクションを処理する。
   */
  handleSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
    return this.questions.handleSelect(interaction);
  }

  /**
   * 質問の Other (自由入力) Modal のインタラクションを処理する。
   */
  handleModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    return this.questions.handleModal(interaction);
  }

  /**
   * ボタンインタラクションを処理する。
   *
   * 質問の Cancel ボタン → 承認ボタンの順に判定する。
   */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    if (await this.questions.handleButton(interaction)) {
      return true;
    }

    const parts = interaction.customId.split(":");
    const action = parts[0];
    const requestId = parts[1];

    if (
      !requestId ||
      (action !== "approve" && action !== "always" && action !== "deny")
    ) {
      return false;
    }

    const pending = this.pending.get(requestId);
    if (!pending) {
      await interaction.reply({
        content: "この承認リクエストは期限切れか、既に処理済みです。",
        flags: MessageFlags.Ephemeral,
      });
      return false;
    }

    clearTimeout(pending.timeout);
    pending.cleanup();
    this.pending.delete(requestId);

    let saveFailed = false;
    if (action === "always") {
      try {
        await addToSettingsAllowList(this.settingsPath, pending.toolName);
      } catch (error: unknown) {
        const msg = getErrorMessage(error);
        log.warn("failed to persist allow list:", msg);
        saveFailed = true;
      }
    }

    const approved = action === "approve" || action === "always";
    const label =
      action === "always" ? "Always Allowed" : approved ? "Allowed" : "Denied";
    // 保存に失敗しても承認は通すが、SDK へ返す reason と表示で保存されていないことを示す。
    const reason = saveFailed ? "Allowed (not persisted)" : label;
    const suffix = saveFailed
      ? STATUS_SUFFIX.notPersisted
      : action === "always"
        ? STATUS_SUFFIX.alwaysAllowed
        : approved
          ? STATUS_SUFFIX.allowed
          : STATUS_SUFFIX.denied;

    pending.resolve({
      decision: approved ? "allow" : "deny",
      reason,
    });

    await interaction.update({
      content: appendStatus(interaction.message.content, suffix),
      components: [],
    });

    log.info("approval resolved:", requestId, label);
    return true;
  }
}

/**
 * ApprovalManager と channelId から SDK の `canUseTool` コールバックを生成する。
 *
 * `requestApproval` の結果 (`ApprovalResult`) を SDK の `PermissionResult` に
 * 変換する。allow 時は入力をそのまま echo back し、deny 時は理由を message に載せる。
 *
 * `AskUserQuestion` は承認ではなく回答収集のツールなので承認フローを通さず、
 * `requestAnswers` で集めた回答を `updatedInput.answers` (質問文 → 選択ラベル)
 * に載せて allow で返す。キャンセル・タイムアウト時は deny で返し、モデルは
 * 回答なしで続行する。
 *
 * 注意: `.claude/settings.json` の `permissions.allow` に `AskUserQuestion` を
 * 入れると SDK が canUseTool を呼ばずに素通しし、回答が空のまま解決される。
 * このツールは allow list に入れないこと。
 *
 * channelId は呼び出し元が必須で渡す (`requestApproval` / `requestAnswers` と
 * 揃える。cron でジョブに channelId が無ければ undefined を渡す)。
 *
 * `turnSignal` (ターン全体のタイムアウト) と SDK が渡す `options.signal` を
 * `AbortSignal.any` で合成し、どちらかが abort されたら承認・質問の待ちを打ち切る。
 */
export function createCanUseTool(
  manager: ApprovalManager,
  channelId: string | undefined,
  turnSignal?: AbortSignal,
): CanUseTool {
  return async (toolName, input, options) => {
    const signal = turnSignal
      ? AbortSignal.any([options.signal, turnSignal])
      : options.signal;
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (!questions) {
        log.warn("malformed AskUserQuestion input");
        return { behavior: "deny", message: "Malformed AskUserQuestion input" };
      }
      const result = await manager.requestAnswers(questions, channelId, signal);
      if (result.kind === "answered") {
        return {
          behavior: "allow",
          updatedInput: { ...input, answers: result.answers },
        };
      }
      return {
        behavior: "deny",
        message: `The user did not answer (${result.reason})`,
      };
    }

    const result = await manager.requestApproval(
      toolName,
      input,
      channelId,
      signal,
    );
    if (result.decision === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: result.reason ?? "Denied" };
  };
}
