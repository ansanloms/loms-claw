import { assertEquals, assertExists } from "@std/assert";
import type {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  Client,
} from "discord.js";
import {
  type ApprovalChannelResolver,
  type ApprovalManager,
  ApprovalManager as ApprovalManagerClass,
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
      _channelId: string | undefined,
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

/**
 * `ApprovalManager` の構築に必要な最小 discord.js `Client`。
 *
 * このスコープのテストは AskUserQuestion (`QuestionManager` 経由) を
 * 経由しないため、`QuestionManager` のコンストラクタが保持するだけの
 * `client` には実際のプロパティアクセスは発生しない。
 */
function fakeClient(): Client {
  return {} as unknown as Client;
}

/** requestApproval() が送信する payload の形。 */
interface SentApprovalPayload {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
}

/** requestApproval() が送信した payload を記録する fake チャンネル解決。 */
function fakeChannelResolver(
  sendableChannelIds: Set<string>,
): { resolver: ApprovalChannelResolver; sent: SentApprovalPayload[] } {
  const sent: SentApprovalPayload[] = [];
  const resolver: ApprovalChannelResolver = {
    fetchSendable: (channelId) => {
      if (!sendableChannelIds.has(channelId)) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        send: (payload) => {
          sent.push(payload);
          return Promise.resolve({ id: "msg-1" });
        },
      });
    },
  };
  return { resolver, sent };
}

/** 送信されたボタン行 (先頭行) から customId 一覧を取り出す。 */
function buttonCustomIds(
  components: ActionRowBuilder<ButtonBuilder>[],
): string[] {
  return components[0].components.map((b) =>
    "custom_id" in b.data ? b.data.custom_id ?? "" : ""
  );
}

/**
 * `handleButton()` が触るプロパティ (customId / message.content / update /
 * reply) だけを持つ fake ボタンインタラクション。
 *
 * `ApprovalManager.handleButton()` は discord.js の `ButtonInteraction` を
 * 要求する。委譲先の `QuestionManager.handleButton()` も同じ型を要求するため、
 * `ApprovalManager` 側の型だけを緩めても discord.js への依存を外しきれない
 * (このテストでは既存コード (`bot/message.test.ts`) と同じ `as unknown as X`
 * のキャストで最小 fake を渡す)。
 */
function fakeButtonInteraction(customId: string): {
  interaction: ButtonInteraction;
  calls: { method: "reply" | "update"; payload: unknown }[];
} {
  const calls: { method: "reply" | "update"; payload: unknown }[] = [];
  const interaction = {
    customId,
    message: { content: "original content" },
    reply: (payload: unknown) => {
      calls.push({ method: "reply", payload });
      return Promise.resolve();
    },
    update: (payload: unknown) => {
      calls.push({ method: "update", payload });
      return Promise.resolve();
    },
  };
  return {
    interaction: interaction as unknown as ButtonInteraction,
    calls,
  };
}

Deno.test("ApprovalManager", async (t) => {
  await t.step(
    "requestApproval → handleButton (approve) で allow に解決すること",
    async () => {
      const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(
        fakeClient(),
        "/tmp/loms-claw-test-nonexistent/settings.json",
        { channelResolver: resolver },
      );

      const pending = manager.requestApproval(
        "Bash",
        { command: "ls" },
        "ch-1",
      );

      // send() は同期的な resolve チェーンの中で呼ばれるため、次の tick で確認する
      await new Promise((r) => setTimeout(r, 0));
      assertEquals(sent.length, 1);
      const [approveId] = buttonCustomIds(sent[0].components);
      const requestId = approveId.split(":")[1];

      const { interaction } = fakeButtonInteraction(`approve:${requestId}`);
      const handled = await manager.handleButton(interaction);
      assertEquals(handled, true);

      const result = await pending;
      assertEquals(result.decision, "allow");
      assertEquals(result.reason, "Allowed");
    },
  );

  await t.step(
    "requestApproval → handleButton (deny) で deny に解決すること",
    async () => {
      const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(
        fakeClient(),
        "/tmp/loms-claw-test-nonexistent/settings.json",
        { channelResolver: resolver },
      );

      const pending = manager.requestApproval(
        "Bash",
        { command: "rm" },
        "ch-1",
      );

      await new Promise((r) => setTimeout(r, 0));
      assertEquals(sent.length, 1);
      const [, , denyId] = buttonCustomIds(sent[0].components);
      const requestId = denyId.split(":")[1];

      const { interaction } = fakeButtonInteraction(`deny:${requestId}`);
      const handled = await manager.handleButton(interaction);
      assertEquals(handled, true);

      const result = await pending;
      assertEquals(result.decision, "deny");
      assertEquals(result.reason, "Denied");
    },
  );

  await t.step(
    "承認待ちがタイムアウトすると deny (Timed out) に解決すること",
    async () => {
      const { resolver } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(
        fakeClient(),
        "/tmp/loms-claw-test-nonexistent/settings.json",
        { channelResolver: resolver, timeoutMs: 10 },
      );

      const result = await manager.requestApproval(
        "Bash",
        { command: "ls" },
        "ch-1",
      );

      assertEquals(result.decision, "deny");
      assertEquals(result.reason, "Timed out");
    },
  );

  await t.step(
    "channelId が undefined の場合は即座に deny すること",
    async () => {
      const { resolver } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(
        fakeClient(),
        "/tmp/loms-claw-test-nonexistent/settings.json",
        { channelResolver: resolver },
      );

      const result = await manager.requestApproval(
        "Bash",
        { command: "ls" },
        undefined,
      );

      assertEquals(result.decision, "deny");
      assertEquals(result.reason, "No approval channel");
    },
  );
});
