import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  STATUS_RESERVE,
  STATUS_SUFFIX,
} from "./manager.ts";
import { appendStatus, type QuestionResult } from "./question.ts";

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
      _signal?: AbortSignal,
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

describe("createCanUseTool", () => {
  test("allow を behavior:allow に変換し入力を echo back すること", async () => {
    const canUseTool = createCanUseTool(
      mockManager({ decision: "allow", reason: "ok" }),
      "ch-1",
    );
    const input = { command: "ls" };
    const result = await canUseTool("Bash", input, toolOptions);

    assert.ok(result, "allow の変換結果が返ること");
    assert.deepStrictEqual(result.behavior, "allow");
    if (result.behavior === "allow") {
      assert.deepStrictEqual(result.updatedInput, input);
    }
  });

  test("deny を behavior:deny に変換し理由を message に載せること", async () => {
    const canUseTool = createCanUseTool(
      mockManager({ decision: "deny", reason: "Denied by user" }),
      "ch-1",
    );
    const result = await canUseTool("Bash", { command: "rm" }, toolOptions);

    assert.ok(result, "deny の変換結果が返ること");
    assert.deepStrictEqual(result.behavior, "deny");
    if (result.behavior === "deny") {
      assert.deepStrictEqual(result.message, "Denied by user");
    }
  });

  test("reason 無しの deny は message が 'Denied' になること", async () => {
    const canUseTool = createCanUseTool(
      mockManager({ decision: "deny" }),
      "ch-1",
    );
    const result = await canUseTool("Bash", {}, toolOptions);

    assert.ok(result, "reason 無し deny の変換結果が返ること");
    assert.deepStrictEqual(result.behavior, "deny");
    if (result.behavior === "deny") {
      assert.deepStrictEqual(result.message, "Denied");
    }
  });

  test("AskUserQuestion の回答を updatedInput.answers に載せて allow すること", async () => {
    const canUseTool = createCanUseTool(
      mockManager(
        { decision: "deny" },
        {
          kind: "answered",
          answers: { "Which one?": "A" },
        },
      ),
      "ch-1",
    );
    const input = askUserQuestionInput();
    const result = await canUseTool("AskUserQuestion", input, toolOptions);

    assert.ok(result, "AskUserQuestion の回答の変換結果が返ること");
    assert.deepStrictEqual(result.behavior, "allow");
    if (result.behavior === "allow") {
      assert.deepStrictEqual(result.updatedInput, {
        ...input,
        answers: { "Which one?": "A" },
      });
    }
  });

  test("AskUserQuestion のキャンセル・タイムアウトは deny に変換すること", async () => {
    const canUseTool = createCanUseTool(
      mockManager(
        { decision: "allow" },
        {
          kind: "denied",
          reason: "Timed out",
        },
      ),
      "ch-1",
    );
    const result = await canUseTool(
      "AskUserQuestion",
      askUserQuestionInput(),
      toolOptions,
    );

    assert.ok(result, "キャンセル・タイムアウトの変換結果が返ること");
    assert.deepStrictEqual(result.behavior, "deny");
    if (result.behavior === "deny") {
      assert.deepStrictEqual(
        result.message,
        "The user did not answer (Timed out)",
      );
    }
  });

  test("AskUserQuestion の不正な入力は承認フローに回さず deny すること", async () => {
    const canUseTool = createCanUseTool(
      mockManager({ decision: "allow" }),
      "ch-1",
    );
    const result = await canUseTool("AskUserQuestion", {}, toolOptions);

    assert.ok(result, "不正な入力の deny 結果が返ること");
    assert.deepStrictEqual(result.behavior, "deny");
    if (result.behavior === "deny") {
      assert.deepStrictEqual(result.message, "Malformed AskUserQuestion input");
    }
  });
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
  options: { failSend?: boolean } = {},
): {
  resolver: ApprovalChannelResolver;
  sent: SentApprovalPayload[];
  edits: { content: string; components: [] }[];
} {
  const sent: SentApprovalPayload[] = [];
  const edits: { content: string; components: [] }[] = [];
  const resolver: ApprovalChannelResolver = {
    fetchSendable: (channelId) => {
      if (!sendableChannelIds.has(channelId)) {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        send: (payload) => {
          if (options.failSend) {
            return Promise.reject(new Error("send failed"));
          }
          sent.push(payload);
          return Promise.resolve({
            content: payload.content,
            edit: (edit) => {
              edits.push(edit);
              return Promise.resolve();
            },
          });
        },
      });
    },
  };
  return { resolver, sent, edits };
}

/** 送信されたボタン行 (先頭行) から customId 一覧を取り出す。 */
function buttonCustomIds(
  components: ActionRowBuilder<ButtonBuilder>[],
): string[] {
  return components[0].components.map((b) =>
    "custom_id" in b.data ? (b.data.custom_id ?? "") : "",
  );
}

/**
 * `handleButton()` が触るプロパティ (customId / message.content / update /
 * reply) だけを持つ fake ボタンインタラクション。
 *
 * `ApprovalManager.handleButton()` は discord.js の `ButtonInteraction` を
 * 要求する。委譲先の `QuestionManager.handleButton()` も同じ型を要求するため、
 * `ApprovalManager` 側の型だけを緩めても discord.js への依存を外しきれない
 * (このテストでは既存コード (`client/discord/message.test.ts`) と同じ `as unknown as X`
 * のキャストで最小 fake を渡す)。
 */
function fakeButtonInteraction(
  customId: string,
  messageContent = "original content",
): {
  interaction: ButtonInteraction;
  calls: { method: "reply" | "update"; payload: unknown }[];
} {
  const calls: { method: "reply" | "update"; payload: unknown }[] = [];
  const interaction = {
    customId,
    message: { content: messageContent },
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

/** 条件が成立するまでポーリングして待つ。上限到達で例外を投げる。 */
async function waitFor(
  cond: () => boolean,
  {
    attempts = 100,
    intervalMs = 10,
  }: {
    attempts?: number;
    intervalMs?: number;
  } = {},
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (cond()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  if (cond()) {
    return;
  }
  throw new Error(
    `waitFor: condition not met within ${
      attempts * intervalMs
    } ms (attempts=${attempts}, intervalMs=${intervalMs})`,
  );
}

describe("ApprovalManager", () => {
  test("requestApproval → handleButton (approve) で allow に解決すること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );

    const pending = manager.requestApproval("Bash", { command: "ls" }, "ch-1");

    // send() は allowlist 読み込み等の複数の await を経て呼ばれるため、送信されるまで待つ
    await waitFor(() => sent.length === 1);
    assert.deepStrictEqual(sent.length, 1);
    const [approveId] = buttonCustomIds(sent[0].components);
    const requestId = approveId.split(":")[1];

    const { interaction } = fakeButtonInteraction(`approve:${requestId}`);
    const handled = await manager.handleButton(interaction);
    assert.deepStrictEqual(handled, true);

    const result = await pending;
    assert.deepStrictEqual(result.decision, "allow");
    assert.deepStrictEqual(result.reason, "Allowed");
  });

  test("requestApproval → handleButton (deny) で deny に解決すること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );

    const pending = manager.requestApproval("Bash", { command: "rm" }, "ch-1");

    await waitFor(() => sent.length === 1);
    assert.deepStrictEqual(sent.length, 1);
    const [, , denyId] = buttonCustomIds(sent[0].components);
    const requestId = denyId.split(":")[1];

    const { interaction } = fakeButtonInteraction(`deny:${requestId}`);
    const handled = await manager.handleButton(interaction);
    assert.deepStrictEqual(handled, true);

    const result = await pending;
    assert.deepStrictEqual(result.decision, "deny");
    assert.deepStrictEqual(result.reason, "Denied");
  });

  test("承認待ちがタイムアウトすると deny (Timed out) に解決すること", async () => {
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

    assert.deepStrictEqual(result.decision, "deny");
    assert.deepStrictEqual(result.reason, "Timed out");
  });

  test("channelId が undefined の場合は即座に deny すること", async () => {
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

    assert.deepStrictEqual(result.decision, "deny");
    assert.deepStrictEqual(result.reason, "No approval channel");
  });
  test("長い description でも送信内容と結果追記後の本文が 2000 文字以内に収まること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );

    const pending = manager.requestApproval(
      "Bash",
      { command: "ls", description: "あ".repeat(600) },
      "ch-1",
    );

    await waitFor(() => sent.length === 1);
    assert.ok(sent[0].content.length <= 2000, "送信内容が 2000 文字以内");
    const [approveId] = buttonCustomIds(sent[0].components);
    const requestId = approveId.split(":")[1];

    // メッセージが上限ちょうどでも、追記後に上限を超えず末尾が残ること
    const { interaction, calls } = fakeButtonInteraction(
      `approve:${requestId}`,
      "x".repeat(2000),
    );
    await manager.handleButton(interaction);
    await pending;

    const payload = calls[0].payload as { content: string };
    assert.ok(payload.content.length <= 2000, "update 後も 2000 文字以内");
    assert.ok(payload.content.endsWith("**→ Allowed**"));
  });

  test("送信に失敗した場合は deny (Failed to post approval request) を返すこと", async () => {
    const { resolver } = fakeChannelResolver(new Set(["ch-1"]), {
      failSend: true,
    });
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );

    const result = await manager.requestApproval(
      "Bash",
      { command: "ls" },
      "ch-1",
    );

    assert.deepStrictEqual(result.decision, "deny");
    assert.deepStrictEqual(result.reason, "Failed to post approval request");
  });

  test("abort されると deny (Aborted) に解決しメッセージが編集され、以後のクリックは pending を解決しないこと", async () => {
    const { resolver, sent, edits } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );
    const controller = new AbortController();

    const pending = manager.requestApproval(
      "Bash",
      { command: "ls" },
      "ch-1",
      controller.signal,
    );
    await waitFor(() => sent.length === 1);
    controller.abort();

    const result = await pending;
    assert.deepStrictEqual(result.decision, "deny");
    assert.deepStrictEqual(result.reason, "Aborted");
    await waitFor(() => edits.length === 1);
    assert.ok(edits[0].content.endsWith("\n**→ Aborted**"));
    assert.deepStrictEqual(edits[0].components, []);

    const [approveId] = buttonCustomIds(sent[0].components);
    const { interaction, calls } = fakeButtonInteraction(
      `approve:${approveId.split(":")[1]}`,
    );
    await manager.handleButton(interaction);
    assert.deepStrictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].method, "reply");
  });

  test("送信前に abort 済みなら投稿せず deny (Aborted) を返すこと", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );

    const result = await manager.requestApproval(
      "Bash",
      { command: "ls" },
      "ch-1",
      AbortSignal.abort(),
    );

    assert.deepStrictEqual(result.reason, "Aborted");
    assert.deepStrictEqual(sent.length, 0);
  });

  test("タイムアウトで投稿メッセージが Timed out に編集されること", async () => {
    const { resolver, edits } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    await manager.requestApproval("Bash", { command: "ls" }, "ch-1");

    await waitFor(() => edits.length === 1);
    assert.ok(edits[0].content.endsWith("\n**→ Timed out**"));
    assert.deepStrictEqual(edits[0].components, []);
  });

  test("createCanUseTool に渡したターンの signal を abort すると承認待ちが打ち切られること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );
    const turn = new AbortController();
    const canUseTool = createCanUseTool(manager, "ch-1", turn.signal);

    const pending = canUseTool("Bash", { command: "ls" }, toolOptions);
    await waitFor(() => sent.length === 1);
    turn.abort();

    const result = await pending;
    assert.ok(result, "結果が返ること");
    assert.deepStrictEqual(result.behavior, "deny");
    if (result.behavior === "deny") {
      assert.deepStrictEqual(result.message, "Aborted");
    }
  });
  test("send の待機中に abort されたら直ちに Aborted へ編集して deny を返し、pending を残さないこと", async () => {
    const controller = new AbortController();
    const edits: { content: string; components: [] }[] = [];
    const resolver: ApprovalChannelResolver = {
      fetchSendable: () =>
        Promise.resolve({
          send: (payload) => {
            controller.abort();
            return Promise.resolve({
              content: payload.content,
              edit: (edit) => {
                edits.push(edit);
                return Promise.resolve();
              },
            });
          },
        }),
    };
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    const result = await manager.requestApproval(
      "Bash",
      { command: "ls" },
      "ch-1",
      controller.signal,
    );

    assert.deepStrictEqual(result.reason, "Aborted");
    await waitFor(() => edits.length === 1);
    assert.ok(edits[0].content.endsWith("\n**→ Aborted**"));
    // timer が残っていれば Timed out の編集が増える
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(edits.length, 1);
  });

  test("description が文字列以外でも承認メッセージが投稿されること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    const pending = manager.requestApproval(
      "Bash",
      { command: "ls", description: 123 },
      "ch-1",
    );
    await waitFor(() => sent.length === 1);
    await pending;
    assert.ok(sent[0].content.startsWith("**Tool: `Bash`**\n```json"));
  });

  test("巨大な input と長い description・ツール名でも閉じフェンスを含み 2000 文字以内であること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    await manager.requestApproval(
      "T".repeat(80),
      { command: "x".repeat(10000), description: "あ".repeat(600) },
      "ch-1",
    );

    const content = sent[0].content;
    assert.ok(content.length <= 2000 - 20, "追記の余白を残して収まること");
    assert.ok(content.endsWith("\n```"), "閉じフェンスで終わること");
  });

  test("チャンネル解決が reject しても deny (Failed to resolve channel) を返すこと", async () => {
    const resolver: ApprovalChannelResolver = {
      fetchSendable: () => Promise.reject(new Error("fetch failed")),
    };
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver },
    );

    const result = await manager.requestApproval(
      "Bash",
      { command: "ls" },
      "ch-1",
    );

    assert.deepStrictEqual(result, {
      decision: "deny",
      reason: "Failed to resolve channel",
    });
  });

  for (const [label, toolName] of [
    ["90 文字のツール名", "T".repeat(90)],
    [": を含むツール名", "mcp:server:tool"],
  ] as const) {
    test(`${label}でも Allow Always が通り、customId が 100 文字以内であること`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "loms-claw-approval-"));
      try {
        const settingsPath = join(dir, "settings.json");
        const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
        const manager = new ApprovalManagerClass(fakeClient(), settingsPath, {
          channelResolver: resolver,
        });

        const pending = manager.requestApproval(toolName, {}, "ch-1");
        await waitFor(() => sent.length === 1);
        const ids = buttonCustomIds(sent[0].components);
        for (const id of ids) {
          assert.ok(id.length <= 100);
        }
        const alwaysId = ids[1];
        assert.ok(alwaysId.startsWith("always:"));

        const { interaction } = fakeButtonInteraction(alwaysId);
        assert.deepStrictEqual(await manager.handleButton(interaction), true);
        const result = await pending;
        assert.deepStrictEqual(result.reason, "Always Allowed");

        const saved = JSON.parse(await readFile(settingsPath, "utf8"));
        assert.deepStrictEqual(saved.permissions.allow, [toolName]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  test("絵文字が切れ目に来ても壊れたサロゲートが残らないこと", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    // 切れ目の位置がずれても、どこかで絵文字が境界に来る。
    for (let pad = 0; pad < 2; pad++) {
      await manager.requestApproval(
        "Bash",
        { command: "a".repeat(pad) + "😀".repeat(2000) },
        "ch-1",
      );
    }

    for (const { content } of sent) {
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(content));
      assert.ok(!/(?<![\ud800-\udbff])[\udc00-\udfff]/.test(content));
    }
  });

  test("入力にバッククォートがあってもフェンスが閉じたままであること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    await manager.requestApproval(
      "Bash",
      { command: "echo ```` ``` done" },
      "ch-1",
    );

    const content = sent[0].content;
    // 開きと閉じの 2 つだけが 3 連バッククォートであること。
    assert.deepStrictEqual(content.match(/```/g)?.length, 2);
    assert.ok(content.endsWith("\n```"));
  });

  test("description とツール名のバッククォートでもフェンスが壊れないこと", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );

    await manager.requestApproval(
      "T```x",
      { command: "ls", description: "run ```rm``` now" },
      "ch-1",
    );

    // 開きと閉じの 2 つだけが 3 連バッククォートであること。
    assert.deepStrictEqual(sent[0].content.match(/```/g)?.length, 2);
  });

  test("ツール名に改行やタブがあってもヘッダが 1 行でインラインコードが閉じたままで、保存されるツール名は元のままであること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-approval-"));
    try {
      const settingsPath = join(dir, "settings.json");
      const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(fakeClient(), settingsPath, {
        channelResolver: resolver,
      });
      const toolName = "mcp\na\tb\r\u007fc`d";

      const pending = manager.requestApproval(toolName, {}, "ch-1");
      await waitFor(() => sent.length === 1);

      const header = sent[0].content.split("\n")[0];
      assert.deepStrictEqual(header, "**Tool: `mcp a b  c'd`**");

      const { interaction } = fakeButtonInteraction(
        buttonCustomIds(sent[0].components)[1],
      );
      assert.deepStrictEqual(await manager.handleButton(interaction), true);
      await pending;

      const saved = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepStrictEqual(saved.permissions.allow, [toolName]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ツール名に単独のバッククォートがあってもヘッダのインラインコードが閉じたままで、保存されるツール名は元のままであること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-approval-"));
    try {
      const settingsPath = join(dir, "settings.json");
      const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(fakeClient(), settingsPath, {
        channelResolver: resolver,
      });
      const toolName = "mcp`a`:tool";

      const pending = manager.requestApproval(toolName, {}, "ch-1");
      await waitFor(() => sent.length === 1);

      const header = sent[0].content.split("\n")[0];
      assert.deepStrictEqual(header, "**Tool: `mcp'a':tool`**");
      assert.deepStrictEqual(header.match(/`/g)?.length, 2);

      const { interaction } = fakeButtonInteraction(
        buttonCustomIds(sent[0].components)[1],
      );
      assert.deepStrictEqual(await manager.handleButton(interaction), true);
      await pending;

      const saved = JSON.parse(await readFile(settingsPath, "utf8"));
      assert.deepStrictEqual(saved.permissions.allow, [toolName]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Allow Always の保存に失敗したら承認は通し、結果表示を保存失敗にすること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-approval-"));
    try {
      const settingsPath = join(dir, "settings.json");
      await writeFile(settingsPath, "{ not json");
      const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
      const manager = new ApprovalManagerClass(fakeClient(), settingsPath, {
        channelResolver: resolver,
      });

      const pending = manager.requestApproval("Bash", {}, "ch-1");
      await waitFor(() => sent.length === 1);
      const { interaction, calls } = fakeButtonInteraction(
        buttonCustomIds(sent[0].components)[1],
      );
      assert.deepStrictEqual(await manager.handleButton(interaction), true);

      const result = await pending;
      assert.deepStrictEqual(result.decision, "allow");
      assert.deepStrictEqual(result.reason, "Allowed (not persisted)");
      const update = calls.find((c) => c.method === "update");
      assert.ok(update);
      const content = (update.payload as { content: string }).content;
      assert.ok(content.endsWith(STATUS_SUFFIX.notPersisted));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("どの結果表示を足しても本文が切れず 2000 文字に収まること", async () => {
    const { resolver, sent } = fakeChannelResolver(new Set(["ch-1"]));
    const manager = new ApprovalManagerClass(
      fakeClient(),
      "/tmp/loms-claw-test-nonexistent/settings.json",
      { channelResolver: resolver, timeoutMs: 10 },
    );
    await manager.requestApproval(
      "Bash",
      { command: "x".repeat(10000) },
      "ch-1",
    );
    const content = sent[0].content;
    for (const suffix of Object.values(STATUS_SUFFIX)) {
      assert.ok(suffix.length <= STATUS_RESERVE);
      assert.deepStrictEqual(appendStatus(content, suffix), content + suffix);
      assert.ok((content + suffix).length <= 2000);
    }
  });
});
