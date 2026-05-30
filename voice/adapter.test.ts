import { assertEquals, assertRejects } from "@std/assert";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import type { QueryFn } from "../claude/mod.ts";
import { askClaudeForVoice } from "./adapter.ts";

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
 */
function mockQueryFn(messages: SDKMessage[]): QueryFn {
  return (_params: Parameters<QueryFn>[0]) => {
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

Deno.test("askClaudeForVoice", async (t) => {
  await t.step("結果テキストとセッション ID を返すこと", async () => {
    const result = await askClaudeForVoice("テスト", {
      config: baseConfig,
      queryFn: mockQueryFn([
        { type: "system", subtype: "init", session_id: "sess-1" } as SDKMessage,
        {
          type: "result",
          subtype: "success",
          result: "応答テキスト",
          session_id: "sess-1",
          is_error: false,
        } as SDKMessage,
      ]),
    });

    assertEquals(result.text, "応答テキスト");
    assertEquals(result.sessionId, "sess-1");
  });

  await t.step("result イベントがない場合はエラーになること", async () => {
    await assertRejects(
      () =>
        askClaudeForVoice("テスト", {
          config: baseConfig,
          queryFn: mockQueryFn([
            {
              type: "system",
              subtype: "init",
              session_id: "sess-1",
            } as SDKMessage,
          ]),
        }),
      Error,
      "claude stream ended without result event",
    );
  });

  await t.step("エラー結果の場合はエラーになること", async () => {
    await assertRejects(
      () =>
        askClaudeForVoice("テスト", {
          config: baseConfig,
          queryFn: mockQueryFn([
            {
              type: "result",
              subtype: "error_max_turns",
              session_id: "sess-1",
              is_error: true,
            } as SDKMessage,
          ]),
        }),
      Error,
      "claude returned error",
    );
  });

  await t.step("queryFn の例外時にエラーになること", async () => {
    await assertRejects(
      () =>
        askClaudeForVoice("テスト", {
          config: baseConfig,
          queryFn: throwingQueryFn("boom"),
        }),
      Error,
      "claude query failed: boom",
    );
  });
});
