import { assertEquals, assertRejects } from "@std/assert";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import {
  askClaude,
  buildQueryOptions,
  normalizeEffort,
  type QueryFn,
} from "./mod.ts";

const baseConfig: ClaudeConfig = {
  maxTurns: 10,
  verbose: false,
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
});
