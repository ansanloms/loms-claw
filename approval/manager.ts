/**
 * Discord ボタンによるツール承認マネージャー。
 *
 * Agent SDK の `canUseTool` コールバックからツール情報を受け取り、
 * Discord にボタン付きメッセージを送信してユーザーの承認/拒否を待つ。
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  type GuildTextBasedChannel,
  MessageFlags,
} from "discord.js";
import type {
  CanUseTool,
  PermissionBehavior,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from "discord.js";
import { addToSettingsAllowList, isInAllowList } from "./settings.ts";
import {
  parseQuestions,
  type Question,
  QuestionManager,
  type QuestionResult,
} from "./question.ts";
import { createLogger } from "../logger.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("approval");

/**
 * 承認タイムアウト（ミリ秒）。
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 承認結果。
 */
export interface ApprovalResult {
  decision: PermissionBehavior;
  reason?: string;
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
    }
  >();
  private channelId: string | null = null;
  private questions: QuestionManager;

  constructor(private client: Client, private settingsPath: string) {
    this.questions = new QuestionManager(client);
  }

  /**
   * 承認リクエストの送信先チャンネルを設定する。
   */
  setChannel(channelId: string): void {
    this.channelId = channelId;
  }

  /**
   * ツール使用の承認をリクエストする。
   *
   * @param toolName - 対象ツール名。
   * @param toolInput - ツールへの入力。承認ボタンの詳細表示に使う。
   * @param channelId - 承認ボタンの送信先チャンネル ID。省略時は setChannel() で設定された値を使う。
   */
  async requestApproval(
    toolName: string,
    toolInput: Record<string, unknown>,
    channelId?: string,
  ): Promise<ApprovalResult> {
    // allow list に含まれるツールは即座に許可する。
    if (await isInAllowList(this.settingsPath, toolName)) {
      log.info("approval resolved:", toolName, "Already Allowed");
      return { decision: "allow", reason: "Already Allowed" };
    }

    channelId = channelId ?? this.channelId ?? undefined;
    if (!channelId) {
      log.warn("no channel set for approval, auto-denying");
      return { decision: "deny", reason: "No approval channel" };
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      log.warn("approval channel not found:", channelId);
      return { decision: "deny", reason: "Channel not found" };
    }

    const requestId = crypto.randomUUID().slice(0, 8);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`approve:${requestId}`)
        .setLabel("Allow")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`always:${requestId}:${toolName}`)
        .setLabel("Allow Always")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`deny:${requestId}`)
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    );

    const description = (toolInput.description as string) ?? "";
    const inputDump = JSON.stringify(toolInput, null, 2);
    const truncated = inputDump.length > 1500
      ? inputDump.slice(0, 1497) + "..."
      : inputDump;

    await (channel as GuildTextBasedChannel).send({
      content: [
        `**Tool: \`${toolName}\`**`,
        ...(description ? [description] : []),
        "```json",
        truncated,
        "```",
      ].join("\n"),
      components: [row],
    });

    log.info("approval requested:", requestId, toolName);

    return new Promise<ApprovalResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn("approval timed out:", requestId);
        resolve({ decision: "deny", reason: "Timed out" });
      }, APPROVAL_TIMEOUT_MS);

      this.pending.set(requestId, { resolve, timeout });
    });
  }

  /**
   * AskUserQuestion の質問への回答をリクエストする。
   *
   * チャンネル解決 (引数 → setChannel() の fallback) はここで行い、
   * 質問メッセージの送信・回答収集は {@link QuestionManager} に委譲する。
   */
  requestAnswers(
    questions: Question[],
    channelId?: string,
  ): Promise<QuestionResult> {
    return this.questions.requestAnswers(
      questions,
      channelId ?? this.channelId ?? undefined,
    );
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
    this.pending.delete(requestId);

    if (action === "always") {
      const alwaysToolName = parts[2];
      if (alwaysToolName) {
        try {
          await addToSettingsAllowList(this.settingsPath, alwaysToolName);
        } catch (error: unknown) {
          const msg = getErrorMessage(error);
          log.warn("failed to persist allow list:", msg);
        }
      }
    }

    const approved = action === "approve" || action === "always";
    const label = action === "always"
      ? "Always Allowed"
      : approved
      ? "Allowed"
      : "Denied";

    pending.resolve({
      decision: approved ? "allow" : "deny",
      reason: label,
    });

    await interaction.update({
      content: interaction.message.content + `\n**→ ${label}**`,
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
 */
export function createCanUseTool(
  manager: ApprovalManager,
  channelId?: string,
): CanUseTool {
  return async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      const questions = parseQuestions(input);
      if (!questions) {
        log.warn("malformed AskUserQuestion input");
        return { behavior: "deny", message: "Malformed AskUserQuestion input" };
      }
      const result = await manager.requestAnswers(questions, channelId);
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

    const result = await manager.requestApproval(toolName, input, channelId);
    if (result.decision === "allow") {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: result.reason ?? "Denied" };
  };
}
