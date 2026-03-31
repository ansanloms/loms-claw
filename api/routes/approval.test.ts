import { assertEquals } from "@std/assert";
import { createApprovalRoutes } from "./approval.ts";
import type {
  ApprovalManager,
  ApprovalResult,
} from "../../approval/manager.ts";
import { Hono } from "hono";

/** テスト用の hook input ボディを生成する。 */
function hookInput(toolName = "Bash", toolInput: unknown = {}) {
  return {
    hook_event_name: "PreToolUse",
    session_id: "test-session",
    transcript_path: "/tmp/test",
    cwd: "/tmp",
    tool_name: toolName,
    tool_use_id: "test-tool-use-id",
    tool_input: toolInput,
  };
}

/**
 * requestApproval のみモックした簡易 ApprovalManager を生成する。
 */
function createMockManager(
  result: ApprovalResult,
): ApprovalManager {
  return {
    requestApproval: () => Promise.resolve(result),
  } as unknown as ApprovalManager;
}

Deno.test("createApprovalRoutes", async (t) => {
  await t.step("承認結果を hookSpecificOutput 形式で返すこと", async () => {
    const manager = createMockManager({
      decision: "allow",
      reason: "user approved",
    });
    const app = new Hono();
    app.route("/approval", createApprovalRoutes(manager));

    const res = await app.request("/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hookInput("Bash", { command: "echo hello" })),
    });

    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.hookSpecificOutput.hookEventName, "PreToolUse");
    assertEquals(json.hookSpecificOutput.permissionDecision, "allow");
    assertEquals(
      json.hookSpecificOutput.permissionDecisionReason,
      "user approved",
    );
  });

  await t.step(
    "reason が未指定の場合は permissionDecisionReason を含まないこと",
    async () => {
      const manager = createMockManager({ decision: "deny" });
      const app = new Hono();
      app.route("/approval", createApprovalRoutes(manager));

      const res = await app.request("/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hookInput("Bash", { command: "rm -rf /" })),
      });

      assertEquals(res.status, 200);
      const json = await res.json();
      assertEquals(json.hookSpecificOutput.permissionDecision, "deny");
      assertEquals(
        "permissionDecisionReason" in json.hookSpecificOutput,
        false,
      );
    },
  );

  await t.step(
    "requestApproval が例外を投げた場合に 500 を返すこと",
    async () => {
      const manager = {
        requestApproval: () => Promise.reject(new Error("timeout")),
      } as unknown as ApprovalManager;
      const app = new Hono();
      app.route("/approval", createApprovalRoutes(manager));
      app.onError((err, c) => {
        return c.json({ error: err.message }, 500);
      });

      const res = await app.request("/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(hookInput()),
      });

      assertEquals(res.status, 500);
      const json = await res.json();
      assertEquals(json.error, "timeout");
    },
  );
});
