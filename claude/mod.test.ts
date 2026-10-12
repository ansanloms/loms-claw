import { describe, test } from "node:test";
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import { errorWith } from "../test-helpers.ts";
import type { ClaudeConfig } from "../config.ts";
import {
  askClaude,
  buildQueryOptions,
  drainResultEvent,
  extractResultText,
  extractTopLevelTextDelta,
  extractTopLevelThinkingDelta,
  handleResultEvent,
  isSessionNotFoundError,
  normalizeEffort,
  type QueryFn,
  requireResultText,
} from "./mod.ts";

const baseConfig: ClaudeConfig = {
  maxTurns: 10,
  timeout: 300000,
  cwd: "/workspace",
  apiPort: 3000,
  defaults: {},
};

/**
 * SDKMessage を順に yield するモック queryFn を生成する。
 *
 * params (prompt / options) を capture できるよう、capture コールバックを受け取る。
 * 単体テストでは iterate のみ行うため、Query の付随メソッドは省略している。
 */
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
 * 呼び出し時に同期的に例外を投げるモック queryFn を生成する。
 */
function throwingQueryFn(message: string): QueryFn {
  return (_params: Parameters<QueryFn>[0]): ReturnType<QueryFn> => {
    throw new Error(message);
  };
}

/**
 * 呼び出し毎に挙動を切り替えるモック queryFn を生成する。
 *
 * 各呼び出しの `behavior` は以下のいずれか:
 *   - `{ throw }`            : 起動時に同期 throw (何も yield しない)
 *   - `{ messages }`         : messages を順に yield
 *   - `{ messages, throw }`  : messages を yield した後に throw
 *
 * 各呼び出しの `resume` を `captureResume` で記録できる。再試行時に resume が
 * 外れていることの検証に使う。
 */
function sequencedQueryFn(
  behaviors: Array<{ messages?: SDKMessage[]; throw?: string }>,
  captureResume?: (resume: string | undefined, callIndex: number) => void,
): QueryFn {
  let call = 0;
  return (params: Parameters<QueryFn>[0]): ReturnType<QueryFn> => {
    const idx = call++;
    captureResume?.(params.options?.resume, idx);
    const behavior = behaviors[idx];
    if (behavior === undefined) {
      throw new Error(`unexpected query call #${idx}`);
    }
    const { messages = [], throw: throwMessage } = behavior;
    async function* gen(): AsyncGenerator<SDKMessage> {
      for (const m of messages) {
        yield m;
      }
      if (throwMessage !== undefined) {
        throw new Error(throwMessage);
      }
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

const SESSION_NOT_FOUND =
  "Claude Code returned an error result: No conversation found with session ID: stale-session";

function resultMessage(sessionId: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    result: "ok",
    session_id: sessionId,
    is_error: false,
  } as SDKMessage;
}

describe("normalizeEffort", () => {
  test("対応する effort をそのまま返すこと", () => {
    assert.deepStrictEqual(normalizeEffort("low"), "low");
    assert.deepStrictEqual(normalizeEffort("high"), "high");
    assert.deepStrictEqual(normalizeEffort("xhigh"), "xhigh");
    assert.deepStrictEqual(normalizeEffort("max"), "max");
  });

  test("非対応の値は undefined になること", () => {
    assert.deepStrictEqual(normalizeEffort("ultra"), undefined);
  });

  test("未指定は undefined になること", () => {
    assert.deepStrictEqual(normalizeEffort(undefined), undefined);
    assert.deepStrictEqual(normalizeEffort(""), undefined);
  });
});

describe("buildQueryOptions", () => {
  const ac = new AbortController();

  test("settingSources に user / project を含むこと", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assert.deepStrictEqual(opts.settingSources, ["user", "project"]);
  });

  test("includePartialMessages が true であること", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assert.deepStrictEqual(opts.includePartialMessages, true);
  });

  test("cwd / maxTurns が config から設定されること", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assert.deepStrictEqual(opts.cwd, "/workspace");
    assert.deepStrictEqual(opts.maxTurns, 10);
  });

  test("systemPrompt が claude_code preset であること", () => {
    const sp = buildQueryOptions(baseConfig, {}, ac).systemPrompt;
    if (typeof sp !== "object" || Array.isArray(sp) || sp.type !== "preset") {
      throw new Error("systemPrompt is not a preset object");
    }
    assert.deepStrictEqual(sp.preset, "claude_code");
    assert.deepStrictEqual(sp.append, undefined);
  });

  test("appendSystemPrompt 指定時に append されること", () => {
    const sp = buildQueryOptions(
      baseConfig,
      { appendSystemPrompt: "extra prompt" },
      ac,
    ).systemPrompt;
    if (typeof sp !== "object" || Array.isArray(sp) || sp.type !== "preset") {
      throw new Error("systemPrompt is not a preset object");
    }
    assert.deepStrictEqual(sp.append, "extra prompt");
  });

  test("sessionId 指定時に resume が設定されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      { sessionId: "session-123" },
      ac,
    );
    assert.deepStrictEqual(opts.resume, "session-123");
  });

  test("sessionId 未指定時は resume を含まないこと", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assert.deepStrictEqual(opts.resume, undefined);
  });

  test("model / effort が設定されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      { model: "opus", effort: "high" },
      ac,
    );
    assert.deepStrictEqual(opts.model, "opus");
    assert.deepStrictEqual(opts.effort, "high");
  });

  test("非対応の effort は設定されないこと", () => {
    const opts = buildQueryOptions(baseConfig, { effort: "ultra" }, ac);
    assert.deepStrictEqual(opts.effort, undefined);
  });

  test("canUseTool 指定時に設定されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      {
        canUseTool: () =>
          Promise.resolve({ behavior: "allow", updatedInput: {} }),
      },
      ac,
    );
    assert.deepStrictEqual(typeof opts.canUseTool, "function");
  });

  test("discordToken 指定時に env へ DISCORD_BOT_TOKEN が注入されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      { discordToken: "bot-token-xyz" },
      ac,
    );
    assert.deepStrictEqual(opts.env?.DISCORD_BOT_TOKEN, "bot-token-xyz");
  });

  test("discordToken 未指定時は env に DISCORD_BOT_TOKEN を含まないこと", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assert.deepStrictEqual(opts.env?.DISCORD_BOT_TOKEN, undefined);
  });
});

describe("askClaude", () => {
  test("全イベントを yield すること", async () => {
    const messages: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      } as SDKMessage,
      {
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "sess-1",
        is_error: false,
      } as SDKMessage,
    ];

    const collected: SDKMessage[] = [];
    for await (const event of askClaude("hello", {
      config: baseConfig,
      queryFn: mockQueryFn(messages),
    })) {
      collected.push(event);
    }

    assert.deepStrictEqual(collected.length, 2);
    assert.deepStrictEqual(collected[0].type, "system");
    assert.deepStrictEqual(collected[1].type, "result");
  });

  test("queryFn に prompt と options が渡されること", async () => {
    let capturedPrompt: unknown;
    let capturedResume: string | undefined;
    const queryFn = mockQueryFn(
      [
        {
          type: "result",
          subtype: "success",
          result: "ok",
          session_id: "s",
          is_error: false,
        } as SDKMessage,
      ],
      (params) => {
        capturedPrompt = params.prompt;
        capturedResume = params.options?.resume;
      },
    );

    for await (const _ of askClaude("hello", {
      config: baseConfig,
      sessionId: "prev-session",
      queryFn,
    })) {
      void _;
    }

    assert.deepStrictEqual(capturedPrompt, "hello");
    assert.deepStrictEqual(capturedResume, "prev-session");
  });

  test("queryFn の例外を診断付きで再 throw すること", async () => {
    await assert.rejects(
      async () => {
        for await (const _ of askClaude("hello", {
          config: baseConfig,
          queryFn: throwingQueryFn("boom"),
        })) {
          void _;
        }
      },
      errorWith(Error, "claude query failed: boom"),
    );
  });

  test("resume 先セッションが存在しない場合は resume を外して新規セッションで再試行すること", async () => {
    const resumes: Array<string | undefined> = [];
    const queryFn = sequencedQueryFn(
      [
        { throw: SESSION_NOT_FOUND },
        { messages: [resultMessage("new-session")] },
      ],
      (resume) => resumes.push(resume),
    );

    const collected: SDKMessage[] = [];
    for await (const event of askClaude("hello", {
      config: baseConfig,
      sessionId: "stale-session",
      queryFn,
    })) {
      collected.push(event);
    }

    // 1 回目は resume あり、2 回目 (再試行) は resume 無し
    assert.deepStrictEqual(resumes, ["stale-session", undefined]);
    // 再試行側の result イベントが yield されること
    assert.deepStrictEqual(collected.length, 1);
    assert.deepStrictEqual(collected[0].type, "result");
  });

  test("再試行は 1 回限りで、再び失敗すれば throw すること", async () => {
    let calls = 0;
    const queryFn = sequencedQueryFn(
      [{ throw: SESSION_NOT_FOUND }, { throw: SESSION_NOT_FOUND }],
      () => calls++,
    );

    await assert.rejects(
      async () => {
        for await (const _ of askClaude("hello", {
          config: baseConfig,
          sessionId: "stale-session",
          queryFn,
        })) {
          void _;
        }
      },
      errorWith(Error, "claude query failed:"),
    );
    // 初回 + 再試行の 2 回で打ち切られること
    assert.deepStrictEqual(calls, 2);
  });

  test("session-not-found 以外のエラーでは再試行しないこと", async () => {
    let calls = 0;
    const queryFn = sequencedQueryFn([{ throw: "boom" }], () => calls++);

    await assert.rejects(
      async () => {
        for await (const _ of askClaude("hello", {
          config: baseConfig,
          sessionId: "stale-session",
          queryFn,
        })) {
          void _;
        }
      },
      errorWith(Error, "claude query failed: boom"),
    );
    assert.deepStrictEqual(calls, 1);
  });

  test("既に yield 済みなら session-not-found でも再試行しないこと", async () => {
    let calls = 0;
    const queryFn = sequencedQueryFn(
      [
        {
          messages: [
            {
              type: "system",
              subtype: "init",
              session_id: "s",
            } as SDKMessage,
          ],
          throw: SESSION_NOT_FOUND,
        },
      ],
      () => calls++,
    );

    const collected: SDKMessage[] = [];
    await assert.rejects(
      async () => {
        for await (const event of askClaude("hello", {
          config: baseConfig,
          sessionId: "stale-session",
          queryFn,
        })) {
          collected.push(event);
        }
      },
      errorWith(Error, "claude query failed:"),
    );
    // yield 済みのイベントは消費側に届いた上で throw、再試行はしない
    assert.deepStrictEqual(collected.length, 1);
    assert.deepStrictEqual(calls, 1);
  });
});

describe("isSessionNotFoundError", () => {
  test("session 不在メッセージを検出すること", () => {
    assert.deepStrictEqual(
      isSessionNotFoundError(
        "Claude Code returned an error result: No conversation found with session ID: abc",
      ),
      true,
    );
  });

  test("無関係なエラーは false になること", () => {
    assert.deepStrictEqual(isSessionNotFoundError("boom"), false);
    assert.deepStrictEqual(
      isSessionNotFoundError("rate limit exceeded"),
      false,
    );
  });
});

describe("extractResultText", () => {
  test("result が文字列なら subtype を問わず返すこと", () => {
    assert.deepStrictEqual(
      extractResultText({
        type: "result",
        subtype: "success",
        result: "応答テキスト",
        session_id: "sess-1",
        is_error: false,
      } as unknown as SDKResultMessage),
      "応答テキスト",
    );
    // non-success でも result があれば採用する。
    assert.deepStrictEqual(
      extractResultText({
        type: "result",
        subtype: "error_max_turns",
        result: "途中まで",
        session_id: "sess-1",
        is_error: true,
      } as unknown as SDKResultMessage),
      "途中まで",
    );
  });

  test("result が無い場合は errors / subtype 付きで throw すること", () => {
    assert.throws(
      () =>
        extractResultText({
          type: "result",
          subtype: "error_max_turns",
          session_id: "sess-1",
          is_error: true,
        } as unknown as SDKResultMessage),
      errorWith(Error, "claude returned error: error_max_turns"),
    );
  });
});

describe("handleResultEvent", () => {
  test("success では onNonSuccess は呼ばれず setSession が session_id で呼ばれること", async () => {
    let nonSuccessCalled = false;
    let capturedSessionId: string | undefined;
    await handleResultEvent(
      {
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "sess-1",
        is_error: false,
      } as unknown as SDKResultMessage,
      {
        onNonSuccess: () => {
          nonSuccessCalled = true;
        },
        setSession: (sessionId) => {
          capturedSessionId = sessionId;
          return Promise.resolve();
        },
      },
    );
    assert.deepStrictEqual(nonSuccessCalled, false);
    assert.deepStrictEqual(capturedSessionId, "sess-1");
  });

  test("非 success では onNonSuccess が呼ばれること", async () => {
    let capturedEvent: SDKResultMessage | undefined;
    await handleResultEvent(
      {
        type: "result",
        subtype: "error_max_turns",
        session_id: "sess-1",
        is_error: true,
      } as unknown as SDKResultMessage,
      {
        onNonSuccess: (event) => {
          capturedEvent = event;
        },
      },
    );
    assert.deepStrictEqual(capturedEvent?.subtype, "error_max_turns");
  });

  test("setSession 未指定でも動くこと", async () => {
    let nonSuccessCalled = false;
    await handleResultEvent(
      {
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "sess-1",
        is_error: false,
      } as unknown as SDKResultMessage,
      {
        onNonSuccess: () => {
          nonSuccessCalled = true;
        },
      },
    );
    assert.deepStrictEqual(nonSuccessCalled, false);
  });
});

describe("drainResultEvent", () => {
  async function* streamOf(events: SDKMessage[]): AsyncGenerator<SDKMessage> {
    for (const event of events) {
      yield event;
    }
  }

  test("result が複数あれば最後を返すこと", async () => {
    const first = {
      type: "result",
      subtype: "success",
      result: "1回目",
      session_id: "sess-1",
      is_error: false,
    } as SDKMessage;
    const last = {
      type: "result",
      subtype: "success",
      result: "2回目",
      session_id: "sess-2",
      is_error: false,
    } as SDKMessage;

    const resultEvent = await drainResultEvent(streamOf([first, last]), {
      onNonSuccess: () => {},
    });

    assert.deepStrictEqual(
      (resultEvent as unknown as SDKResultMessage | undefined)?.session_id,
      "sess-2",
    );
  });

  test("result が無ければ undefined を返すこと", async () => {
    const resultEvent = await drainResultEvent(
      streamOf([{ type: "system", subtype: "init" } as SDKMessage]),
      { onNonSuccess: () => {} },
    );
    assert.deepStrictEqual(resultEvent, undefined);
  });
});

describe("requireResultText", () => {
  test("resultEvent が undefined なら throw すること", () => {
    assert.throws(
      () => requireResultText(undefined),
      errorWith(Error, "claude stream ended without result event"),
    );
  });

  test("success なら本文を返すこと", () => {
    assert.deepStrictEqual(
      requireResultText({
        type: "result",
        subtype: "success",
        result: "応答テキスト",
        session_id: "sess-1",
        is_error: false,
      } as unknown as SDKResultMessage),
      "応答テキスト",
    );
  });
});

describe("extractTopLevelTextDelta", () => {
  test("トップレベルの text_delta は差分テキストを返すこと", () => {
    assert.deepStrictEqual(
      extractTopLevelTextDelta({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "あ" },
        },
      } as unknown as SDKMessage),
      "あ",
    );
  });

  test("サブエージェント (parent_tool_use_id あり) は undefined になること", () => {
    assert.deepStrictEqual(
      extractTopLevelTextDelta({
        type: "stream_event",
        parent_tool_use_id: "tool-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "あ" },
        },
      } as unknown as SDKMessage),
      undefined,
    );
  });

  test("text_delta 以外のイベントは undefined になること", () => {
    assert.deepStrictEqual(
      extractTopLevelTextDelta({
        type: "result",
        subtype: "success",
      } as unknown as SDKMessage),
      undefined,
    );
  });
});

describe("extractTopLevelThinkingDelta", () => {
  test("トップレベルの thinking_delta は差分テキストを返すこと", () => {
    assert.deepStrictEqual(
      extractTopLevelThinkingDelta({
        type: "stream_event",
        parent_tool_use_id: null,
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "考え中" },
        },
      } as unknown as SDKMessage),
      "考え中",
    );
  });

  test("サブエージェント (parent_tool_use_id あり) は undefined になること", () => {
    assert.deepStrictEqual(
      extractTopLevelThinkingDelta({
        type: "stream_event",
        parent_tool_use_id: "tool-1",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "考え中" },
        },
      } as unknown as SDKMessage),
      undefined,
    );
  });

  test("thinking_delta 以外のイベントは undefined になること", () => {
    assert.deepStrictEqual(
      extractTopLevelThinkingDelta({
        type: "result",
        subtype: "success",
      } as unknown as SDKMessage),
      undefined,
    );
  });
});
