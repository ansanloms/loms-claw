/**
 * 承認フック（PreToolUse）ルート。
 *
 * Discord ボタンによるツール承認/拒否を HTTP エンドポイントとして提供する。
 */

import { Hono } from "hono";
import type { PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalManager,
  ApprovalResult,
} from "../../approval/manager.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-approval");

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
 * 承認フックルートを生成する。
 */
export function createApprovalRoutes(manager: ApprovalManager) {
  const app = new Hono();

  app.post("/", async (c) => {
    const input = (await c.req.json()) as PreToolUseHookInput;
    log.debug("hook input:", JSON.stringify(input));
    const result = await manager.requestApproval(input);
    return c.json(toHookOutput(result));
  });

  return app;
}
