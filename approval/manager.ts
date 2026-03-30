/**
 * Discord ボタンによるツール承認マネージャー。
 *
 * Claude Code の PreToolUse フックからツール情報を受け取り、
 * Discord にボタン付きメッセージを送信してユーザーの承認/拒否を待つ。
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  type GuildTextBasedChannel,
} from "discord.js";
import type {
  PermissionBehavior,
  PreToolUseHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../logger.ts";

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
  private alwaysAllowed = new Set<string>();
  private channelId: string | null = null;

  constructor(private client: Client) {}

  /**
   * 承認リクエストの送信先チャンネルを設定する。
   */
  setChannel(channelId: string): void {
    this.channelId = channelId;
  }

  /**
   * ツール使用の承認をリクエストする。
   *
   * @param input - PreToolUse フックからのツール情報。
   * @param channelId - 承認ボタンの送信先チャンネル ID。省略時は setChannel() で設定された値を使う。
   */
  async requestApproval(
    input: PreToolUseHookInput,
    channelId?: string,
  ): Promise<ApprovalResult> {
    const toolName = input.tool_name;

    // Always Allow 済みのツールは自動承認
    if (this.alwaysAllowed.has(toolName)) {
      log.info("auto-approved (always allow):", toolName);
      return { decision: "allow", reason: "Always allowed" };
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

    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
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
   * ボタンインタラクションを処理する。
   */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
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
      return false;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);

    if (action === "always") {
      const alwaysToolName = parts[2];
      if (alwaysToolName) {
        this.alwaysAllowed.add(alwaysToolName);
        log.info("added to always-allow:", alwaysToolName);
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
