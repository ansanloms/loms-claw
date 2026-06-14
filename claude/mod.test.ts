import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import {
  askClaude,
  buildQueryOptions,
  extractResultText,
  extractTopLevelTextDelta,
  isSessionNotFoundError,
  normalizeEffort,
  type QueryFn,
} from "./mod.ts";

const baseConfig: ClaudeConfig = {
  maxTurns: 10,
  verbose: false,
  timeout: 300000,
  cwd: "/workspace",
  discordBotToken: "test-bot-token",
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

Deno.test("normalizeEffort", async (t) => {
  await t.step("対応する effort をそのまま返すこと", () => {
    assertEquals(normalizeEffort("low"), "low");
    assertEquals(normalizeEffort("high"), "high");
    assertEquals(normalizeEffort("xhigh"), "xhigh");
    assertEquals(normalizeEffort("max"), "max");
  });

  await t.step("非対応の値は undefined になること", () => {
    assertEquals(normalizeEffort("ultra"), undefined);
  });

  await t.step("未指定は undefined になること", () => {
    assertEquals(normalizeEffort(undefined), undefined);
    assertEquals(normalizeEffort(""), undefined);
  });
});

Deno.test("buildQueryOptions", async (t) => {
  const ac = new AbortController();

  await t.step("settingSources に user / project を含むこと", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assertEquals(opts.settingSources, ["user", "project"]);
  });

  await t.step("includePartialMessages が true であること", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assertEquals(opts.includePartialMessages, true);
  });

  await t.step("cwd / maxTurns が config から設定されること", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assertEquals(opts.cwd, "/workspace");
    assertEquals(opts.maxTurns, 10);
  });

  await t.step("systemPrompt が claude_code preset であること", () => {
    const sp = buildQueryOptions(baseConfig, {}, ac).systemPrompt;
    if (typeof sp !== "object" || Array.isArray(sp)) {
      throw new Error("systemPrompt is not a preset object");
    }
    assertEquals(sp.preset, "claude_code");
    assertEquals(sp.append, undefined);
  });

  await t.step("appendSystemPrompt 指定時に append されること", () => {
    const sp = buildQueryOptions(
      baseConfig,
      { appendSystemPrompt: "extra prompt" },
      ac,
    ).systemPrompt;
    if (typeof sp !== "object" || Array.isArray(sp)) {
      throw new Error("systemPrompt is not a preset object");
    }
    assertEquals(sp.append, "extra prompt");
  });

  await t.step("sessionId 指定時に resume が設定されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      { sessionId: "session-123" },
      ac,
    );
    assertEquals(opts.resume, "session-123");
  });

  await t.step("sessionId 未指定時は resume を含まないこと", () => {
    const opts = buildQueryOptions(baseConfig, {}, ac);
    assertEquals(opts.resume, undefined);
  });

  await t.step("model / effort が設定されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      { model: "opus", effort: "high" },
      ac,
    );
    assertEquals(opts.model, "opus");
    assertEquals(opts.effort, "high");
  });

  await t.step("非対応の effort は設定されないこと", () => {
    const opts = buildQueryOptions(baseConfig, { effort: "ultra" }, ac);
    assertEquals(opts.effort, undefined);
  });

  await t.step("canUseTool 指定時に設定されること", () => {
    const opts = buildQueryOptions(
      baseConfig,
      {
        canUseTool: () =>
          Promise.resolve({ behavior: "allow", updatedInput: {} }),
      },
      ac,
    );
    assertEquals(typeof opts.canUseTool, "function");
  });
});

Deno.test("askClaude", async (t) => {
  await t.step("全イベントを yield すること", async () => {
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
    for await (
      const event of askClaude("hello", {
        config: baseConfig,
        queryFn: mockQueryFn(messages),
      })
    ) {
      collected.push(event);
    }

    assertEquals(collected.length, 2);
    assertEquals(collected[0].type, "system");
    assertEquals(collected[1].type, "result");
  });

  await t.step("queryFn に prompt と options が渡されること", async () => {
    let capturedPrompt: unknown;
    let capturedResume: string | undefined;
    const queryFn = mockQueryFn(
      [{
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "s",
        is_error: false,
      } as SDKMessage],
      (params) => {
        capturedPrompt = params.prompt;
        capturedResume = params.options?.resume;
      },
    );

    for await (
      const _ of askClaude("hello", {
        config: baseConfig,
        sessionId: "prev-session",
        queryFn,
      })
    ) {
      void _;
    }

    assertEquals(capturedPrompt, "hello");
    assertEquals(capturedResume, "prev-session");
  });

  await t.step("queryFn の例外を診断付きで再 throw すること", async () => {
    await assertRejects(
      async () => {
        for await (
          const _ of askClaude("hello", {
            config: baseConfig,
            queryFn: throwingQueryFn("boom"),
          })
        ) {
          void _;
        }
      },
      Error,
      "claude query failed: boom",
    );
  });

  await t.step(
    "resume 先セッションが存在しない場合は resume を外して新規セッションで再試行すること",
    async () => {
      const resumes: Array<string | undefined> = [];
      const queryFn = sequencedQueryFn(
        [
          { throw: SESSION_NOT_FOUND },
          { messages: [resultMessage("new-session")] },
        ],
        (resume) => resumes.push(resume),
      );

      const collected: SDKMessage[] = [];
      for await (
        const event of askClaude("hello", {
          config: baseConfig,
          sessionId: "stale-session",
          queryFn,
        })
      ) {
        collected.push(event);
      }

      // 1 回目は resume あり、2 回目 (再試行) は resume 無し
      assertEquals(resumes, ["stale-session", undefined]);
      // 再試行側の result イベントが yield されること
      assertEquals(collected.length, 1);
      assertEquals(collected[0].type, "result");
    },
  );

  await t.step(
    "再試行は 1 回限りで、再び失敗すれば throw すること",
    async () => {
      let calls = 0;
      const queryFn = sequencedQueryFn(
        [
          { throw: SESSION_NOT_FOUND },
          { throw: SESSION_NOT_FOUND },
        ],
        () => calls++,
      );

      await assertRejects(
        async () => {
          for await (
            const _ of askClaude("hello", {
              config: baseConfig,
              sessionId: "stale-session",
              queryFn,
            })
          ) {
            void _;
          }
        },
        Error,
        "claude query failed:",
      );
      // 初回 + 再試行の 2 回で打ち切られること
      assertEquals(calls, 2);
    },
  );

  await t.step(
    "session-not-found 以外のエラーでは再試行しないこと",
    async () => {
      let calls = 0;
      const queryFn = sequencedQueryFn([{ throw: "boom" }], () => calls++);

      await assertRejects(
        async () => {
          for await (
            const _ of askClaude("hello", {
              config: baseConfig,
              sessionId: "stale-session",
              queryFn,
            })
          ) {
            void _;
          }
        },
        Error,
        "claude query failed: boom",
      );
      assertEquals(calls, 1);
    },
  );

  await t.step(
    "既に yield 済みなら session-not-found でも再試行しないこと",
    async () => {
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
      await assertRejects(
        async () => {
          for await (
            const event of askClaude("hello", {
              config: baseConfig,
              sessionId: "stale-session",
              queryFn,
            })
          ) {
            collected.push(event);
          }
        },
        Error,
        "claude query failed:",
      );
      // yield 済みのイベントは消費側に届いた上で throw、再試行はしない
      assertEquals(collected.length, 1);
      assertEquals(calls, 1);
    },
  );
});

Deno.test("isSessionNotFoundError", async (t) => {
  await t.step("session 不在メッセージを検出すること", () => {
    assertEquals(
      isSessionNotFoundError(
        "Claude Code returned an error result: No conversation found with session ID: abc",
      ),
      true,
    );
  });

  await t.step("無関係なエラーは false になること", () => {
    assertEquals(isSessionNotFoundError("boom"), false);
    assertEquals(isSessionNotFoundError("rate limit exceeded"), false);
  });
});

Deno.test("extractResultText", async (t) => {
  await t.step("result が文字列なら subtype を問わず返すこと", () => {
    assertEquals(
      extractResultText(
        {
          type: "result",
          subtype: "success",
          result: "応答テキスト",
          session_id: "sess-1",
          is_error: false,
        } as unknown as SDKResultMessage,
      ),
      "応答テキスト",
    );
    // non-success でも result があれば採用する。
    assertEquals(
      extractResultText(
        {
          type: "result",
          subtype: "error_max_turns",
          result: "途中まで",
          session_id: "sess-1",
          is_error: true,
        } as unknown as SDKResultMessage,
      ),
      "途中まで",
    );
  });

  await t.step(
    "result が無い場合は errors / subtype 付きで throw すること",
    () => {
      assertThrows(
        () =>
          extractResultText(
            {
              type: "result",
              subtype: "error_max_turns",
              session_id: "sess-1",
              is_error: true,
            } as unknown as SDKResultMessage,
          ),
        Error,
        "claude returned error: error_max_turns",
      );
    },
  );
});

Deno.test("extractTopLevelTextDelta", async (t) => {
  await t.step("トップレベルの text_delta は差分テキストを返すこと", () => {
    assertEquals(
      extractTopLevelTextDelta(
        {
          type: "stream_event",
          parent_tool_use_id: null,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "あ" },
          },
        } as unknown as SDKMessage,
      ),
      "あ",
    );
  });

  await t.step(
    "サブエージェント (parent_tool_use_id あり) は undefined になること",
    () => {
      assertEquals(
        extractTopLevelTextDelta(
          {
            type: "stream_event",
            parent_tool_use_id: "tool-1",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "あ" },
            },
          } as unknown as SDKMessage,
        ),
        undefined,
      );
    },
  );

  await t.step("text_delta 以外のイベントは undefined になること", () => {
    assertEquals(
      extractTopLevelTextDelta(
        { type: "result", subtype: "success" } as unknown as SDKMessage,
      ),
      undefined,
    );
  });
});
