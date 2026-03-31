import { assertEquals, assertRejects } from "@std/assert";
import type { ClaudeConfig } from "../config.ts";
import type { CommandSpawner } from "../claude/mod.ts";
import { askClaudeForVoice } from "./adapter.ts";

const baseConfig: ClaudeConfig = {
  maxTurns: 10,
  verbose: false,
  timeout: 300000,
  cwd: "/workspace",
  approvalPort: 3000,
  discordMcpEnabled: true,
  discordMcpPort: 3001,
};

/**
 * モック CommandSpawner を生成する。
 */
function mockSpawner(
  lines: Record<string, unknown>[],
  exitCode = 0,
): CommandSpawner {
  return () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) {
          controller.enqueue(encoder.encode(JSON.stringify(line) + "\n"));
        }
        controller.close();
      },
    }),
    stderr: Promise.resolve(""),
    status: Promise.resolve({
      success: exitCode === 0,
      code: exitCode,
      signal: null,
    }),
  });
}

Deno.test("askClaudeForVoice", async (t) => {
  await t.step("結果テキストとセッション ID を返すこと", async () => {
    const result = await askClaudeForVoice("テスト", {
      config: baseConfig,
      spawner: mockSpawner([
        { type: "system", subtype: "init", session_id: "sess-1" },
        {
          type: "result",
          subtype: "success",
          result: "応答テキスト",
          session_id: "sess-1",
          is_error: false,
        },
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
          spawner: mockSpawner([
            { type: "system", subtype: "init", session_id: "sess-1" },
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
          spawner: mockSpawner([
            {
              type: "result",
              subtype: "error_max_turns",
              session_id: "sess-1",
              is_error: true,
            },
          ]),
        }),
      Error,
      "claude returned error",
    );
  });

  await t.step("非ゼロ終了コードでエラーになること", async () => {
    await assertRejects(
      () =>
        askClaudeForVoice("テスト", {
          config: baseConfig,
          spawner: mockSpawner([], 1),
        }),
      Error,
      "exited with code 1",
    );
  });
});
