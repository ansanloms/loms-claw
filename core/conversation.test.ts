import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
  CanUseTool,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn } from "../claude/mod.ts";
import type { ClaudeConfig } from "../config.ts";
import type { StoreScope } from "../store/mod.ts";
import {
  Conversation,
  type ConversationDeps,
  FLUSH_THRESHOLD,
  runOneShot,
  SELF_MENTION_PROMPT_NOTE,
  THINKING_FLUSH_THRESHOLD,
  type TurnInput,
  type TurnOutput,
} from "./conversation.ts";
import { errorWith } from "../test-helpers.ts";

const baseConfig: ClaudeConfig = {
  cwd: "/tmp/workspace",
  maxTurns: 5,
  timeout: 60_000,
  defaults: {},
  apiPort: 0,
} as unknown as ClaudeConfig;

/** 呼び出し順を記録する。 */
type Calls = string[];

function mockQueryFn(
  messages: SDKMessage[],
  capture?: (params: Parameters<QueryFn>[0]) => void,
): QueryFn {
  return (params: Parameters<QueryFn>[0]) => {
    capture?.(params);
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const m of messages) {
        yield m;
      }
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

/**
 * イベントの間に観測用の関数を挟めるモック。関数ステップは、直前のイベントを
 * 呼び出し側が消費し終えた (= そのイベントによる出力が済んだ) 時点で走る。
 */
function steppedQueryFn(steps: Array<SDKMessage | (() => void)>): QueryFn {
  return () => {
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const step of steps) {
        if (typeof step === "function") {
          step();
        } else {
          yield step;
        }
      }
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

function throwingQueryFn(message: string): QueryFn {
  return (): ReturnType<QueryFn> => {
    throw new Error(message);
  };
}

function textDelta(text: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage;
}

function thinkingDelta(thinking: string): SDKMessage {
  return {
    type: "stream_event",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking },
    },
  } as unknown as SDKMessage;
}

function assistantEvent(parentToolUseId: string | null = null): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: parentToolUseId,
    message: {},
  } as unknown as SDKMessage;
}

function toolProgress(toolName: string, elapsed: number): SDKMessage {
  return {
    type: "tool_progress",
    tool_name: toolName,
    elapsed_time_seconds: elapsed,
  } as unknown as SDKMessage;
}

function resultEvent(
  result: string,
  sessionId = "sess-new",
  subtype = "success",
): SDKResultMessage {
  return {
    type: "result",
    subtype,
    result,
    session_id: sessionId,
    is_error: false,
  } as unknown as SDKResultMessage;
}

interface FakeOutputOptions {
  calls?: Calls;
  onTurnStart?: () => Promise<void>;
  preparePrompt?: (prompt: string) => Promise<string | undefined>;
  notifyError?: (error: unknown) => Promise<void>;
}

function createOutput(options: FakeOutputOptions = {}) {
  const calls: Calls = options.calls ?? [];
  const replies: string[] = [];
  const thinkings: string[] = [];
  const progresses: Array<[string, number]> = [];
  const errors: unknown[] = [];
  const prepared: string[] = [];
  const output: TurnOutput = {
    onQueued: () => {
      calls.push("onQueued");
    },
    onTurnStart: () => {
      calls.push("onTurnStart");
      return options.onTurnStart ? options.onTurnStart() : Promise.resolve();
    },
    preparePrompt: (prompt) => {
      calls.push("preparePrompt");
      prepared.push(prompt);
      return options.preparePrompt
        ? options.preparePrompt(prompt)
        : Promise.resolve(prompt);
    },
    sendReply: (text) => {
      calls.push("sendReply");
      replies.push(text);
      return Promise.resolve();
    },
    sendThinking: (text) => {
      calls.push("sendThinking");
      thinkings.push(text);
      return Promise.resolve();
    },
    reportProgress: (toolName, elapsed) => {
      calls.push("reportProgress");
      progresses.push([toolName, elapsed]);
      return Promise.resolve();
    },
    notifyError: (error) => {
      calls.push("notifyError");
      errors.push(error);
      return options.notifyError
        ? options.notifyError(error)
        : Promise.resolve();
    },
    onTurnEnd: () => {
      calls.push("onTurnEnd");
      return Promise.resolve();
    },
  };
  return { output, calls, replies, thinkings, progresses, errors, prepared };
}

interface DepsOverrides {
  queryFn?: QueryFn;
  showThinking?: boolean;
  sessionId?: string;
  tryConsume?: () => boolean;
  isExhausted?: () => boolean;
  env?: Record<string, string>;
}

function createConversation(overrides: DepsOverrides = {}) {
  const savedSessions: Array<[StoreScope, string]> = [];
  const resolveCalls: Array<[string, StoreScope, Record<string, string>?]> = [];
  const canUseToolIds: string[] = [];
  const deps: ConversationDeps = {
    store: {
      getSession: () => Promise.resolve(overrides.sessionId),
      setSession: (scope, id) => {
        savedSessions.push([scope, id]);
        return Promise.resolve();
      },
      getModel: () => Promise.resolve("opus"),
      getEffort: () => Promise.resolve("high"),
      getShowThinking: () => Promise.resolve(overrides.showThinking ?? false),
    },
    systemPrompts: {
      resolve: (context, scope, vars) => {
        resolveCalls.push([context, scope as StoreScope, vars]);
        return "SYSTEM";
      },
    },
    claudeConfig: baseConfig,
    env: overrides.env,
    createCanUseTool: (id) => {
      canUseToolIds.push(id);
      return (() =>
        Promise.resolve({
          behavior: "allow",
          updatedInput: {},
        })) as unknown as CanUseTool;
    },
    selfMentionLimiter: {
      tryConsume: overrides.tryConsume ?? (() => true),
      isExhausted: overrides.isExhausted ?? (() => false),
    },
    queryFn: overrides.queryFn,
  };
  return {
    conversation: new Conversation(deps),
    savedSessions,
    resolveCalls,
    canUseToolIds,
  };
}

function createInput(overrides: Partial<TurnInput> = {}): TurnInput {
  return {
    scope: { channelId: "ch-1" },
    localId: "ch-1",
    prompt: "hello",
    isSelfMessage: false,
    templateVars: { "discord.guild.id": "g-1" },
    ...overrides,
  };
}

describe("Conversation", () => {
  test("submit: 通常ターンのフック呼び出し順が onTurnStart, preparePrompt, sendReply, onTurnEnd であること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([resultEvent("answer")]),
    });
    const { output, calls, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(calls, [
      "onTurnStart",
      "preparePrompt",
      "sendReply",
      "onTurnEnd",
    ]);
    assert.deepStrictEqual(replies, ["answer"]);
  });

  test("submit: 同一 scope が実行中のときだけ onQueued が呼ばれること", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { conversation } = createConversation({
      queryFn: mockQueryFn([resultEvent("answer")]),
    });
    const first = createOutput({
      preparePrompt: async (p) => {
        await gate;
        return p;
      },
    });
    const second = createOutput();
    const other = createOutput();

    const p1 = conversation.submit(createInput(), first.output);
    const p2 = conversation.submit(createInput(), second.output);
    const p3 = conversation.submit(
      createInput({ localId: "ch-2", scope: { channelId: "ch-2" } }),
      other.output,
    );

    assert.deepStrictEqual(first.calls.includes("onQueued"), false);
    assert.deepStrictEqual(second.calls[0], "onQueued");
    assert.deepStrictEqual(other.calls.includes("onQueued"), false);
    // 待機中のターンはまだ始まっていない。
    assert.deepStrictEqual(second.calls.includes("onTurnStart"), false);

    release();
    await Promise.all([p1, p2, p3]);

    assert.deepStrictEqual(second.calls, [
      "onQueued",
      "onTurnStart",
      "preparePrompt",
      "sendReply",
      "onTurnEnd",
    ]);
  });

  test("submit: 回答が FLUSH_THRESHOLD 以上たまると文境界で中間送信されること", async () => {
    const long = "あ".repeat(FLUSH_THRESHOLD) + "。";
    const { conversation } = createConversation({
      queryFn: mockQueryFn([
        textDelta(long),
        textDelta("残り"),
        resultEvent("ignored"),
      ]),
    });
    const { output, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(replies, [long, "残り"]);
  });

  test("submit: assistant イベントで未送信のテキストが強制フラッシュされること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([
        textDelta("一つ目"),
        assistantEvent(),
        textDelta("二つ目"),
        assistantEvent(),
        resultEvent("ignored"),
      ]),
    });
    const { output, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(replies, ["一つ目", "二つ目"]);
  });

  test("submit: showThinking 有効で thinking が回答より先に送信されること", async () => {
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: mockQueryFn([
        thinkingDelta("考え中"),
        textDelta("答え"),
        resultEvent("ignored"),
      ]),
    });
    const { output, calls, thinkings, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(thinkings, ["考え中"]);
    assert.deepStrictEqual(replies, ["答え"]);
    assert.deepStrictEqual(
      calls.filter((c) => c === "sendThinking" || c === "sendReply"),
      ["sendThinking", "sendReply"],
    );
  });

  test("submit: thinking が THINKING_FLUSH_THRESHOLD 以上たまると中間送信されること", async () => {
    const long = "い".repeat(THINKING_FLUSH_THRESHOLD) + "。";
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: mockQueryFn([
        thinkingDelta(long),
        thinkingDelta("続き"),
        textDelta("答え"),
        resultEvent("ignored"),
      ]),
    });
    const { output, thinkings } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(thinkings, [long, "続き"]);
  });

  test("submit: showThinking 無効では thinking が送信されないこと", async () => {
    const { conversation } = createConversation({
      showThinking: false,
      queryFn: mockQueryFn([
        thinkingDelta("考え中"),
        textDelta("答え"),
        resultEvent("ignored"),
      ]),
    });
    const { output, thinkings, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(thinkings, []);
    assert.deepStrictEqual(replies, ["答え"]);
  });

  test("submit: result イベントでセッションが保存されること", async () => {
    const { conversation, savedSessions } = createConversation({
      queryFn: mockQueryFn([resultEvent("answer", "sess-42")]),
    });
    const { output } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(savedSessions, [[{ channelId: "ch-1" }, "sess-42"]]);
  });

  test("submit: tool_progress が reportProgress へ渡されること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([toolProgress("Bash", 3), resultEvent("answer")]),
    });
    const { output, progresses } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(progresses, [["Bash", 3]]);
  });

  test("submit: ストリームされたテキストが無ければ result のテキストを送信すること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([resultEvent("フォールバック")]),
    });
    const { output, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(replies, ["フォールバック"]);
  });

  test("submit: result イベントが無ければ notifyError と onTurnEnd が呼ばれること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([]),
    });
    const { output, calls, errors } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(calls, [
      "onTurnStart",
      "preparePrompt",
      "notifyError",
      "onTurnEnd",
    ]);
    assert.deepStrictEqual(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.ok(
      (errors[0] as Error).message.includes(
        "claude stream ended without result event",
      ),
    );
  });

  test("submit: query が失敗しても notifyError と onTurnEnd が呼ばれること", async () => {
    const { conversation } = createConversation({
      queryFn: throwingQueryFn("boom"),
    });
    const { output, calls } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(calls.slice(-2), ["notifyError", "onTurnEnd"]);
  });

  test("submit: notifyError が失敗しても握り潰して onTurnEnd が呼ばれること", async () => {
    const { conversation } = createConversation({
      queryFn: throwingQueryFn("boom"),
    });
    const { output, calls } = createOutput({
      notifyError: () => Promise.reject(new Error("send failed")),
    });

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(calls.slice(-2), ["notifyError", "onTurnEnd"]);
  });

  test("submit: preparePrompt が失敗したら notifyError と onTurnEnd が呼ばれること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([resultEvent("answer")]),
    });
    const { output, calls } = createOutput({
      preparePrompt: () => Promise.reject(new Error("download failed")),
    });

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(calls, [
      "onTurnStart",
      "preparePrompt",
      "notifyError",
      "onTurnEnd",
    ]);
  });

  test("submit: onTurnStart が失敗したら notifyError と onTurnEnd が呼ばれ submit は解決すること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([resultEvent("answer")]),
    });
    const { output, calls } = createOutput({
      onTurnStart: () => Promise.reject(new Error("typing failed")),
    });

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(calls, ["onTurnStart", "notifyError", "onTurnEnd"]);
  });

  test("submit: preparePrompt が空を返したら query を実行せず onTurnEnd で終わること", async () => {
    let queried = false;
    const { conversation } = createConversation({
      queryFn: (() => {
        queried = true;
        throw new Error("must not be called");
      }) as unknown as QueryFn,
    });
    const { output, calls } = createOutput({
      preparePrompt: () => Promise.resolve(""),
    });

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(queried, false);
    assert.deepStrictEqual(calls, [
      "onTurnStart",
      "preparePrompt",
      "onTurnEnd",
    ]);
  });

  test("submit: 加工後のプロンプトとシステムプロンプト・env・設定が query に渡ること", async () => {
    let captured: Parameters<QueryFn>[0] | undefined;
    const { conversation, resolveCalls, canUseToolIds } = createConversation({
      sessionId: "prev-sess",
      env: { DISCORD_BOT_TOKEN: "tok" },
      queryFn: mockQueryFn([resultEvent("answer")], (p) => {
        captured = p;
      }),
    });
    const { output } = createOutput({
      preparePrompt: (p) => Promise.resolve(`${p} + image`),
    });

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(captured?.prompt, "hello + image");
    assert.deepStrictEqual(captured?.options?.resume, "prev-sess");
    assert.deepStrictEqual(captured?.options?.model, "opus");
    assert.deepStrictEqual(captured?.options?.effort, "high");
    assert.deepStrictEqual(captured?.options?.env?.DISCORD_BOT_TOKEN, "tok");
    assert.deepStrictEqual(captured?.options?.systemPrompt, {
      type: "preset",
      preset: "claude_code",
      append: "SYSTEM",
    });
    assert.deepStrictEqual(resolveCalls, [
      ["chat", { channelId: "ch-1" }, { "discord.guild.id": "g-1" }],
    ]);
    assert.deepStrictEqual(canUseToolIds, ["ch-1"]);
  });

  test("submit: 自己メンション起動では注記がプロンプト先頭に付くこと", async () => {
    let captured: Parameters<QueryFn>[0] | undefined;
    const { conversation } = createConversation({
      queryFn: mockQueryFn([resultEvent("answer")], (p) => {
        captured = p;
      }),
    });
    const { output } = createOutput();

    await conversation.submit(createInput({ isSelfMessage: true }), output);

    assert.deepStrictEqual(
      captured?.prompt,
      `${SELF_MENTION_PROMPT_NOTE}\n\nhello`,
    );
  });

  test("submit: 通常起動では注記が付かず、レート枠も消費しないこと", async () => {
    let captured: Parameters<QueryFn>[0] | undefined;
    let consumed = 0;
    const { conversation } = createConversation({
      tryConsume: () => {
        consumed += 1;
        return true;
      },
      queryFn: mockQueryFn([resultEvent("answer")], (p) => {
        captured = p;
      }),
    });
    const { output } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(captured?.prompt, "hello");
    assert.deepStrictEqual(consumed, 0);
  });

  test("submit: 自己メンションのレート超過では query を実行せず onTurnEnd で終わること", async () => {
    let queried = false;
    const { conversation } = createConversation({
      tryConsume: () => false,
      queryFn: (() => {
        queried = true;
        throw new Error("must not be called");
      }) as unknown as QueryFn,
    });
    const { output, calls, replies } = createOutput();

    await conversation.submit(createInput({ isSelfMessage: true }), output);

    assert.deepStrictEqual(queried, false);
    assert.deepStrictEqual(replies, []);
    assert.deepStrictEqual(calls, [
      "onTurnStart",
      "preparePrompt",
      "onTurnEnd",
    ]);
  });

  test("SELF_MENTION_PROMPT_NOTE: 自己メンションである旨の見出しで始まること", () => {
    assert.ok(SELF_MENTION_PROMPT_NOTE.startsWith("[AI to AI 自己メンション]"));
  });

  test("submit: 閾値未満では文境界があっても中間送信しないこと", async () => {
    const replies: string[] = [];
    const snapshots: number[] = [];
    const { conversation } = createConversation({
      queryFn: steppedQueryFn([
        // 長さ 799 (閾値 800 の 1 つ手前)。境界はあるが送らない。
        textDelta("あ".repeat(798) + "。"),
        () => snapshots.push(replies.length),
        resultEvent("ignored"),
      ]),
    });
    const { output } = createOutput();
    output.sendReply = (text) => {
      replies.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(snapshots, [0]);
    assert.deepStrictEqual(replies, ["あ".repeat(798) + "。"]);
  });

  test("submit: 閾値ちょうど (800 文字) に達した時点で文境界まで中間送信されること", async () => {
    const replies: string[] = [];
    const snapshots: string[][] = [];
    const head = "あ".repeat(500) + "。";
    const { conversation } = createConversation({
      queryFn: steppedQueryFn([
        textDelta(head + "い".repeat(FLUSH_THRESHOLD - head.length)),
        () => snapshots.push([...replies]),
        textDelta("後"),
        resultEvent("ignored"),
      ]),
    });
    const { output } = createOutput();
    output.sendReply = (text) => {
      replies.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    // 境界までだけを即時に送り、残りは次へ持ち越す。
    assert.deepStrictEqual(snapshots, [[head]]);
    assert.deepStrictEqual(replies, [
      head,
      "い".repeat(FLUSH_THRESHOLD - head.length) + "後",
    ]);
  });

  test("submit: 閾値以上でも境界が無ければ送らずにため、2 倍に達すると強制送信されること", async () => {
    const half = "x".repeat(FLUSH_THRESHOLD);
    const replies: string[] = [];
    const snapshots: number[] = [];
    const { conversation } = createConversation({
      queryFn: steppedQueryFn([
        textDelta(half),
        () => snapshots.push(replies.length),
        textDelta(half),
        () => snapshots.push(replies.length),
        resultEvent("ignored"),
      ]),
    });
    const { output, errors } = createOutput();
    output.sendReply = (text) => {
      replies.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(snapshots, [0, 1]);
    assert.deepStrictEqual(replies, [half + half]);
  });

  test("submit: 短い文境界だけでは中間送信せず、assistant か終了時にまとめて送ること", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([
        textDelta("短い。"),
        textDelta("続き"),
        resultEvent("ignored"),
      ]),
    });
    const { output, replies } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(replies, ["短い。続き"]);
  });

  test("submit: thinking が THINKING_FLUSH_THRESHOLD 未満では中間送信しないこと", async () => {
    const thinkings: string[] = [];
    const snapshots: number[] = [];
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: steppedQueryFn([
        // 長さ 1499。境界はあるが閾値に 1 足りないので送らない。
        thinkingDelta("あ".repeat(1498) + "。"),
        () => snapshots.push(thinkings.length),
        resultEvent("answer"),
      ]),
    });
    const { output } = createOutput();
    output.sendThinking = (text) => {
      thinkings.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(snapshots, [0]);
  });

  test("submit: thinking が THINKING_FLUSH_THRESHOLD ちょうどに達した時点で境界まで中間送信されること", async () => {
    const thinkings: string[] = [];
    const snapshots: string[][] = [];
    const head = "い".repeat(900) + "。";
    const tail = "う".repeat(THINKING_FLUSH_THRESHOLD - head.length);
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: steppedQueryFn([
        thinkingDelta(head + tail),
        () => snapshots.push([...thinkings]),
        thinkingDelta("続き"),
        resultEvent("answer"),
      ]),
    });
    const { output } = createOutput();
    output.sendThinking = (text) => {
      thinkings.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(snapshots, [[head]]);
    assert.deepStrictEqual(thinkings, [head, tail + "続き"]);
  });

  test("submit: thinking に境界が無いまま閾値を超えても送らずにため、エラーにならないこと", async () => {
    const long = "x".repeat(THINKING_FLUSH_THRESHOLD);
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: mockQueryFn([thinkingDelta(long), resultEvent("answer")]),
    });
    const { output, thinkings, errors } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(thinkings, [long]);
  });

  test("submit: 回答テキストが来た時点で、境界の無い未送出 thinking が先に送られること", async () => {
    const order: string[] = [];
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: mockQueryFn([
        thinkingDelta("考え中"),
        textDelta("あ".repeat(FLUSH_THRESHOLD - 1) + "。"),
        resultEvent("ignored"),
      ]),
    });
    const { output } = createOutput();
    output.sendThinking = (text) => {
      order.push(`thinking:${text}`);
      return Promise.resolve();
    };
    output.sendReply = () => {
      order.push("reply");
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(order, ["thinking:考え中", "reply"]);
  });

  test("submit: assistant イベントで境界の無い thinking も送られること", async () => {
    const thinkings: string[] = [];
    const snapshots: number[] = [];
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: steppedQueryFn([
        thinkingDelta("考え中"),
        assistantEvent(),
        () => snapshots.push(thinkings.length),
        resultEvent("answer"),
      ]),
    });
    const { output } = createOutput();
    output.sendThinking = (text) => {
      thinkings.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(snapshots, [1]);
    assert.deepStrictEqual(thinkings, ["考え中"]);
  });

  test("submit: 終了時に境界の無い thinking が残っていれば送られること", async () => {
    const { conversation } = createConversation({
      showThinking: true,
      queryFn: mockQueryFn([thinkingDelta("考え中"), resultEvent("answer")]),
    });
    const { output, thinkings } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(thinkings, ["考え中"]);
  });

  test("submit: サブエージェントの assistant イベントでは強制フラッシュしないこと", async () => {
    const replies: string[] = [];
    const snapshots: number[] = [];
    const { conversation } = createConversation({
      queryFn: steppedQueryFn([
        textDelta("本文"),
        assistantEvent("toolu_sub"),
        () => snapshots.push(replies.length),
        resultEvent("ignored"),
      ]),
    });
    const { output } = createOutput();
    output.sendReply = (text) => {
      replies.push(text);
      return Promise.resolve();
    };

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(snapshots, [0]);
    assert.deepStrictEqual(replies, ["本文"]);
  });

  test("submit: tool_progress 以外の未知のイベントでは reportProgress を呼ばないこと", async () => {
    const { conversation } = createConversation({
      queryFn: mockQueryFn([
        { type: "system", subtype: "init" } as unknown as SDKMessage,
        resultEvent("answer"),
      ]),
    });
    const { output, progresses } = createOutput();

    await conversation.submit(createInput(), output);

    assert.deepStrictEqual(progresses, []);
  });

  test("isSelfMentionExhausted: limiter の判定を返すこと", () => {
    const exhausted = createConversation({ isExhausted: () => true });
    const free = createConversation({ isExhausted: () => false });

    assert.deepStrictEqual(
      exhausted.conversation.isSelfMentionExhausted(),
      true,
    );
    assert.deepStrictEqual(free.conversation.isSelfMentionExhausted(), false);
  });
});

describe("runOneShot", () => {
  test("結果テキストを返し、セッションを保存すること", async () => {
    const saved: string[] = [];

    const text = await runOneShot({
      prompt: "do it",
      config: baseConfig,
      sessionId: "prev",
      setSession: (id) => {
        saved.push(id);
        return Promise.resolve();
      },
      onNonSuccess: () => {},
      queryFn: mockQueryFn([resultEvent("done", "sess-9")]),
    });

    assert.deepStrictEqual(text, "done");
    assert.deepStrictEqual(saved, ["sess-9"]);
  });

  test("非 success の result で onNonSuccess が呼ばれること", async () => {
    const subtypes: string[] = [];

    const text = await runOneShot({
      prompt: "do it",
      config: baseConfig,
      onNonSuccess: (event) => subtypes.push(event.subtype),
      queryFn: mockQueryFn([resultEvent("partial", "s", "error_max_turns")]),
    });

    assert.deepStrictEqual(text, "partial");
    assert.deepStrictEqual(subtypes, ["error_max_turns"]);
  });

  test("result イベントが無ければ throw すること", async () => {
    await assert.rejects(
      runOneShot({
        prompt: "do it",
        config: baseConfig,
        onNonSuccess: () => {},
        queryFn: mockQueryFn([]),
      }),
      errorWith(Error, "claude stream ended without result event"),
    );
  });

  test("env とモデル設定が query に渡ること", async () => {
    let captured: Parameters<QueryFn>[0] | undefined;

    await runOneShot({
      prompt: "do it",
      config: baseConfig,
      env: { FOO: "bar" },
      model: "sonnet",
      effort: "low",
      appendSystemPrompt: "SYS",
      onNonSuccess: () => {},
      queryFn: mockQueryFn([resultEvent("done")], (p) => {
        captured = p;
      }),
    });

    assert.deepStrictEqual(captured?.options?.env?.FOO, "bar");
    assert.deepStrictEqual(captured?.options?.model, "sonnet");
    assert.deepStrictEqual(captured?.options?.effort, "low");
  });
});
