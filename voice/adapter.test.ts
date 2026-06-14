import { assertEquals, assertRejects } from "@std/assert";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import type { QueryFn } from "../claude/mod.ts";
import { streamClaudeForVoice, type VoiceStreamEvent } from "./adapter.ts";

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

/**
 * テキスト差分 1 つを含むトップレベルの stream_event を生成する。
 */
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

/**
 * 非同期ジェネレータの yield をすべて収集する。
 */
async function collect(
  gen: AsyncGenerator<VoiceStreamEvent>,
): Promise<VoiceStreamEvent[]> {
  const events: VoiceStreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

Deno.test("streamClaudeForVoice", async (t) => {
  await t.step(
    "stream_event のテキストを文単位で yield し end を返すこと",
    async () => {
      const events = await collect(
        streamClaudeForVoice("テスト", {
          config: baseConfig,
          queryFn: mockQueryFn([
            textDelta("こんにちは。"),
            {
              type: "result",
              subtype: "success",
              result: "こんにちは。",
              session_id: "sess-1",
              is_error: false,
            } as SDKMessage,
          ]),
        }),
      );

      assertEquals(events, [
        { type: "text", text: "こんにちは。" },
        { type: "end", sessionId: "sess-1" },
      ]);
    },
  );

  await t.step(
    "stream_event が無い場合は result テキストを文単位に分割すること",
    async () => {
      const events = await collect(
        streamClaudeForVoice("テスト", {
          config: baseConfig,
          queryFn: mockQueryFn([
            {
              type: "result",
              subtype: "success",
              result: "応答です。続きます。",
              session_id: "sess-2",
              is_error: false,
            } as SDKMessage,
          ]),
        }),
      );

      assertEquals(events, [
        { type: "text", text: "応答です。" },
        { type: "text", text: "続きます。" },
        { type: "end", sessionId: "sess-2" },
      ]);
    },
  );

  await t.step("result イベントがない場合はエラーになること", async () => {
    await assertRejects(
      () =>
        collect(
          streamClaudeForVoice("テスト", {
            config: baseConfig,
            queryFn: mockQueryFn([
              {
                type: "system",
                subtype: "init",
                session_id: "sess-1",
              } as SDKMessage,
            ]),
          }),
        ),
      Error,
      "claude stream ended without result event",
    );
  });

  await t.step("エラー結果の場合はエラーになること", async () => {
    await assertRejects(
      () =>
        collect(
          streamClaudeForVoice("テスト", {
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
        ),
      Error,
      "claude returned error",
    );
  });

  await t.step("queryFn の例外時にエラーになること", async () => {
    await assertRejects(
      () =>
        collect(
          streamClaudeForVoice("テスト", {
            config: baseConfig,
            queryFn: throwingQueryFn("boom"),
          }),
        ),
      Error,
      "claude query failed: boom",
    );
  });
});
