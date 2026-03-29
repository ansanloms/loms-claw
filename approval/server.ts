/**
 * 承認 HTTP サーバー。
 *
 * Claude Code の PreToolUse HTTP フックからのリクエストを受け付け、
 * ApprovalManager に委譲して Discord ボタンでユーザーの応答を待つ。
 * localhost のみでリッスンする。
 *
 * フック入力: PreToolUse の JSON（tool_name, tool_input 等）
 * フック出力: { hookSpecificOutput: { hookEventName, permissionDecision, ... } }
 */

import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type { ApprovalManager, ApprovalResult } from "./manager.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("approval-server");

/**
 * ApprovalResult を PreToolUse フックの出力 JSON に変換する。
 */
function toHookOutput(result: ApprovalResult) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: result.decision,
      ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
    },
  };
}

/**
 * 承認 HTTP サーバーを起動する。
 *
 * @param manager - 承認マネージャー
 * @param port - リッスンポート（デフォルト: 3000）
 * @returns サーバーインスタンス（shutdown 用）
 */
export function startApprovalServer(
  manager: ApprovalManager,
  port: number = 3000,
): Deno.HttpServer {
  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    async (req) => {
      if (
        req.method === "POST" &&
        new URL(req.url).pathname === "/approval"
      ) {
        try {
          const input = (await req.json()) as PreToolUseHookInput;

          log.debug("hook input:", JSON.stringify(input));

          const result = await manager.requestApproval(input);

          return new Response(
            JSON.stringify(toHookOutput(result)),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          );
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : String(error);
          log.error("approval request error:", msg);
          return new Response(
            JSON.stringify({ error: msg }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  );

  log.info("approval server started on port", port);
  return server;
}
