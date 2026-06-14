import { assertEquals } from "@std/assert";
import {
  type ApprovalManager,
  type ApprovalResult,
  createCanUseTool,
} from "./manager.ts";

/**
 * requestApproval が固定の ApprovalResult を返すモック ApprovalManager。
 */
function mockManager(result: ApprovalResult): ApprovalManager {
  return {
    requestApproval: (
      _toolName: string,
      _toolInput: Record<string, unknown>,
      _channelId?: string,
    ) => Promise.resolve(result),
  } as unknown as ApprovalManager;
}

/** canUseTool の第 3 引数 (options) の最小モック。 */
const toolOptions = {
  signal: new AbortController().signal,
  toolUseID: "tu-1",
};

Deno.test("createCanUseTool", async (t) => {
  await t.step(
    "allow を behavior:allow に変換し入力を echo back すること",
    async () => {
      const canUseTool = createCanUseTool(
        mockManager({ decision: "allow", reason: "ok" }),
        "ch-1",
      );
      const input = { command: "ls" };
      const result = await canUseTool("Bash", input, toolOptions);

      assertEquals(result.behavior, "allow");
      if (result.behavior === "allow") {
        assertEquals(result.updatedInput, input);
      }
    },
  );

  await t.step(
    "deny を behavior:deny に変換し理由を message に載せること",
    async () => {
      const canUseTool = createCanUseTool(
        mockManager({ decision: "deny", reason: "Denied by user" }),
        "ch-1",
      );
      const result = await canUseTool("Bash", { command: "rm" }, toolOptions);

      assertEquals(result.behavior, "deny");
      if (result.behavior === "deny") {
        assertEquals(result.message, "Denied by user");
      }
    },
  );

  await t.step(
    "reason 無しの deny は message が 'Denied' になること",
    async () => {
      const canUseTool = createCanUseTool(
        mockManager({ decision: "deny" }),
        "ch-1",
      );
      const result = await canUseTool("Bash", {}, toolOptions);

      assertEquals(result.behavior, "deny");
      if (result.behavior === "deny") {
        assertEquals(result.message, "Denied");
      }
    },
  );
});
