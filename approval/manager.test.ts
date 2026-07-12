import { assertEquals, assertExists } from "@std/assert";
import {
  type ApprovalManager,
  type ApprovalResult,
  createCanUseTool,
} from "./manager.ts";
import type { QuestionResult } from "./question.ts";

/**
 * requestApproval / requestAnswers が固定の結果を返すモック ApprovalManager。
 */
function mockManager(
  result: ApprovalResult,
  answersResult?: QuestionResult,
): ApprovalManager {
  return {
    requestApproval: (
      _toolName: string,
      _toolInput: Record<string, unknown>,
      _channelId?: string,
    ) => Promise.resolve(result),
    requestAnswers: () =>
      Promise.resolve(
        answersResult ?? { kind: "denied", reason: "unexpected" },
      ),
  } as unknown as ApprovalManager;
}

/**
 * AskUserQuestion の正しい入力を生成する。
 */
function askUserQuestionInput(): Record<string, unknown> {
  return {
    questions: [
      {
        question: "Which one?",
        header: "Choice",
        options: [
          { label: "A", description: "a" },
          { label: "B", description: "b" },
        ],
        multiSelect: false,
      },
    ],
  };
}

/** canUseTool の第 3 引数 (options) の最小モック。 */
const toolOptions = {
  signal: new AbortController().signal,
  toolUseID: "tu-1",
  requestId: "req-1",
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

      assertExists(result);
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

      assertExists(result);
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

      assertExists(result);
      assertEquals(result.behavior, "deny");
      if (result.behavior === "deny") {
        assertEquals(result.message, "Denied");
      }
    },
  );

  await t.step(
    "AskUserQuestion の回答を updatedInput.answers に載せて allow すること",
    async () => {
      const canUseTool = createCanUseTool(
        mockManager({ decision: "deny" }, {
          kind: "answered",
          answers: { "Which one?": "A" },
        }),
        "ch-1",
      );
      const input = askUserQuestionInput();
      const result = await canUseTool("AskUserQuestion", input, toolOptions);

      assertExists(result);
      assertEquals(result.behavior, "allow");
      if (result.behavior === "allow") {
        assertEquals(result.updatedInput, {
          ...input,
          answers: { "Which one?": "A" },
        });
      }
    },
  );

  await t.step(
    "AskUserQuestion のキャンセル・タイムアウトは deny に変換すること",
    async () => {
      const canUseTool = createCanUseTool(
        mockManager({ decision: "allow" }, {
          kind: "denied",
          reason: "Timed out",
        }),
        "ch-1",
      );
      const result = await canUseTool(
        "AskUserQuestion",
        askUserQuestionInput(),
        toolOptions,
      );

      assertExists(result);
      assertEquals(result.behavior, "deny");
      if (result.behavior === "deny") {
        assertEquals(result.message, "The user did not answer (Timed out)");
      }
    },
  );

  await t.step(
    "AskUserQuestion の不正な入力は承認フローに回さず deny すること",
    async () => {
      const canUseTool = createCanUseTool(
        mockManager({ decision: "allow" }),
        "ch-1",
      );
      const result = await canUseTool("AskUserQuestion", {}, toolOptions);

      assertExists(result);
      assertEquals(result.behavior, "deny");
      if (result.behavior === "deny") {
        assertEquals(result.message, "Malformed AskUserQuestion input");
      }
    },
  );
});
