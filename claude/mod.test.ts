import { assertEquals, assertRejects } from "@std/assert";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import {
  askClaude,
  buildArgs,
  buildHookSettings,
  type CommandSpawner,
  parseNdjsonStream,
} from "./mod.ts";

const baseConfig: ClaudeConfig = {
  maxTurns: 10,
  verbose: false,
  timeout: 300000,
  cwd: "/workspace",
  approvalPort: 3000,
};

Deno.test("buildArgs", async (t) => {
  await t.step("stream-json を出力フォーマットに指定すること", () => {
    const args = buildArgs("hello", baseConfig);
    const idx = args.indexOf("--output-format");
    assertEquals(idx >= 0, true);
    assertEquals(args[idx + 1], "stream-json");
  });

  await t.step("--verbose を常に含むこと", () => {
    const args = buildArgs("hello", { ...baseConfig, verbose: false });
    assertEquals(args.includes("--verbose"), true);
  });

  await t.step("--max-turns を含むこと", () => {
    const args = buildArgs("hello", baseConfig);
    assertEquals(args.includes("--max-turns"), true);
    assertEquals(args.includes("10"), true);
  });

  await t.step("セッション ID 指定時に --resume を含むこと", () => {
    const args = buildArgs("hello", baseConfig, "session-123");
    const idx = args.indexOf("--resume");
    assertEquals(idx >= 0, true);
    assertEquals(args[idx + 1], "session-123");
  });

  await t.step("--settings にフック設定を含むこと", () => {
    const args = buildArgs("hello", baseConfig);
    assertEquals(args.includes("--settings"), true);
  });

  await t.step(
    "appendSystemPrompt 指定時に --append-system-prompt を含むこと",
    () => {
      const args = buildArgs("hello", baseConfig, undefined, "extra prompt");
      const idx = args.indexOf("--append-system-prompt");
      assertEquals(idx >= 0, true);
      assertEquals(args[idx + 1], "extra prompt");
    },
  );

  await t.step(
    "appendSystemPrompt 未指定時は --append-system-prompt を含まないこと",
    () => {
      const args = buildArgs("hello", baseConfig);
      assertEquals(args.includes("--append-system-prompt"), false);
    },
  );
});

Deno.test("buildHookSettings", async (t) => {
  await t.step("正しい URL とタイムアウトの JSON を生成すること", () => {
    const json = buildHookSettings(4000);
    const parsed = JSON.parse(json);
    assertEquals(
      parsed.hooks.PreToolUse[0].hooks[0].url,
      "http://127.0.0.1:4000/approval",
    );
    assertEquals(parsed.hooks.PreToolUse[0].hooks[0].type, "http");
    assertEquals(parsed.hooks.PreToolUse[0].hooks[0].timeout, 300);
  });
});

Deno.test("parseNdjsonStream", async (t) => {
  await t.step("NDJSON 行を SDKMessage に変換すること", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "sess-1",
        is_error: false,
      },
    ];

    const ndjson = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson));
        controller.close();
      },
    });

    const collected: SDKMessage[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      collected.push(event);
    }

    assertEquals(collected.length, 2);
    assertEquals(collected[0].type, "system");
    assertEquals(collected[1].type, "result");
  });

  await t.step("空行をスキップすること", async () => {
    const line = JSON.stringify({
      type: "result",
      result: "ok",
      session_id: "s",
      is_error: false,
    });
    const ndjson = "\n" + line + "\n\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson));
        controller.close();
      },
    });

    const collected: SDKMessage[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      collected.push(event);
    }

    assertEquals(collected.length, 1);
  });

  await t.step("不正な JSON 行をスキップすること", async () => {
    const valid = JSON.stringify({
      type: "result",
      result: "ok",
      session_id: "s",
      is_error: false,
    });
    const ndjson = "not json\n" + valid + "\n";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(ndjson));
        controller.close();
      },
    });

    const collected: SDKMessage[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      collected.push(event);
    }

    assertEquals(collected.length, 1);
    assertEquals(collected[0].type, "result");
  });
});

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

Deno.test("askClaude", async (t) => {
  await t.step("全イベントを yield すること", async () => {
    const messages = [
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "tool_progress",
        tool_use_id: "tu-1",
        tool_name: "Bash",
        parent_tool_use_id: null,
        elapsed_time_seconds: 5,
        session_id: "sess-1",
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
        session_id: "sess-1",
        is_error: false,
      },
    ];

    const collected: SDKMessage[] = [];
    for await (
      const event of askClaude("hello", {
        config: baseConfig,
        spawner: mockSpawner(messages),
      })
    ) {
      collected.push(event);
    }

    assertEquals(collected.length, 3);
    assertEquals(collected[0].type, "system");
    assertEquals(collected[1].type, "tool_progress");
    assertEquals(collected[2].type, "result");
  });

  await t.step("非ゼロ終了コードでエラーになること", async () => {
    await assertRejects(
      async () => {
        for await (
          const _ of askClaude("hello", {
            config: baseConfig,
            spawner: mockSpawner([], 1),
          })
        ) {
          void _;
        }
      },
      Error,
      "exited with code 1",
    );
  });

  await t.step("セッション ID が引数に渡されること", async () => {
    let capturedArgs: string[] = [];
    const inner = mockSpawner([
      {
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "s",
        is_error: false,
      },
    ]);
    const spawner: CommandSpawner = (args, cwd, signal) => {
      capturedArgs = args;
      return inner(args, cwd, signal);
    };

    for await (
      const _ of askClaude("hello", {
        config: baseConfig,
        sessionId: "prev-session",
        spawner,
      })
    ) {
      void _;
    }

    assertEquals(capturedArgs.includes("--resume"), true);
    assertEquals(
      capturedArgs[capturedArgs.indexOf("--resume") + 1],
      "prev-session",
    );
  });
});
