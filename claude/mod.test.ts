import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type { ClaudeConfig } from "../config.ts";
import {
  askClaude,
  buildArgs,
  buildHookSettings,
  type CommandResult,
  parseClaudeOutput,
} from "./mod.ts";

const baseConfig: ClaudeConfig = {
  maxTurns: 10,
  verbose: false,
  timeout: 300000,
  cwd: "/workspace",
  approvalPort: 3000,
};

Deno.test("buildArgs", async (t) => {
  await t.step("最小限の引数を構築すること", () => {
    const args = buildArgs("hello", baseConfig);
    assertEquals(args.includes("-p"), true);
    assertEquals(args.includes("hello"), true);
    assertEquals(args.includes("--output-format"), true);
    assertEquals(args.includes("json"), true);
    assertEquals(args.includes("--max-turns"), true);
    assertEquals(args.includes("10"), true);
  });

  await t.step("verbose 有効時に --verbose を含むこと", () => {
    const args = buildArgs("hello", { ...baseConfig, verbose: true });
    assertEquals(args.includes("--verbose"), true);
  });

  await t.step("verbose 無効時に --verbose を含まないこと", () => {
    const args = buildArgs("hello", baseConfig);
    assertEquals(args.includes("--verbose"), false);
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

Deno.test("parseClaudeOutput", async (t) => {
  await t.step("単一オブジェクト（非 verbose）をパースできること", () => {
    const json = JSON.stringify({
      type: "result",
      result: "hello world",
      session_id: "sess-1",
      is_error: false,
    });
    const response = parseClaudeOutput(json);
    assertEquals(response.result, "hello world");
    assertEquals(response.sessionId, "sess-1");
  });

  await t.step("配列（verbose モード）をパースできること", () => {
    const json = JSON.stringify([
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "result",
        result: "hello verbose",
        session_id: "sess-1",
        is_error: false,
      },
    ]);
    const response = parseClaudeOutput(json);
    assertEquals(response.result, "hello verbose");
    assertEquals(response.sessionId, "sess-1");
  });

  await t.step("空の出力でエラーになること", () => {
    try {
      parseClaudeOutput("");
      throw new Error("should have thrown");
    } catch (e) {
      assertStringIncludes((e as Error).message, "empty output");
    }
  });

  await t.step("不正な JSON でエラーになること", () => {
    try {
      parseClaudeOutput("not json");
      throw new Error("should have thrown");
    } catch (e) {
      assertStringIncludes((e as Error).message, "invalid JSON");
    }
  });

  await t.step("result イベントがない配列でエラーになること", () => {
    const json = JSON.stringify([
      { type: "system", subtype: "init" },
    ]);
    try {
      parseClaudeOutput(json);
      throw new Error("should have thrown");
    } catch (e) {
      assertStringIncludes((e as Error).message, "no result event");
    }
  });

  await t.step("is_error が true の場合にエラーになること", () => {
    const json = JSON.stringify({
      type: "result",
      result: "something went wrong",
      session_id: "sess-1",
      is_error: true,
    });
    try {
      parseClaudeOutput(json);
      throw new Error("should have thrown");
    } catch (e) {
      assertStringIncludes((e as Error).message, "claude returned error");
    }
  });

  await t.step("result テキストが空の場合にエラーになること", () => {
    const json = JSON.stringify({
      type: "result",
      result: "",
      session_id: "sess-1",
    });
    try {
      parseClaudeOutput(json);
      throw new Error("should have thrown");
    } catch (e) {
      assertStringIncludes((e as Error).message, "empty result");
    }
  });
});

Deno.test("askClaude", async (t) => {
  await t.step("モックスポーナーで結果をパースできること", async () => {
    const mockSpawner = (
      _args: string[],
      _cwd: string,
    ): Promise<CommandResult> =>
      Promise.resolve({
        stdout: JSON.stringify({
          type: "result",
          result: "mocked response",
          session_id: "mock-session",
          is_error: false,
        }),
        stderr: "",
        success: true,
        code: 0,
      });

    const response = await askClaude("hello", {
      config: baseConfig,
      spawner: mockSpawner,
    });

    assertEquals(response.result, "mocked response");
    assertEquals(response.sessionId, "mock-session");
  });

  await t.step("非ゼロ終了コードでエラーになること", async () => {
    const mockSpawner = (): Promise<CommandResult> =>
      Promise.resolve({
        stdout: "",
        stderr: "error message",
        success: false,
        code: 1,
      });

    await assertRejects(
      () => askClaude("hello", { config: baseConfig, spawner: mockSpawner }),
      Error,
      "exited with code 1",
    );
  });

  await t.step("セッション ID が引数に渡されること", async () => {
    let capturedArgs: string[] = [];
    const mockSpawner = (args: string[]): Promise<CommandResult> => {
      capturedArgs = args;
      return Promise.resolve({
        stdout: JSON.stringify({
          type: "result",
          result: "ok",
          session_id: "s",
          is_error: false,
        }),
        stderr: "",
        success: true,
        code: 0,
      });
    };

    await askClaude("hello", {
      config: baseConfig,
      sessionId: "prev-session",
      spawner: mockSpawner,
    });

    assertEquals(capturedArgs.includes("--resume"), true);
    assertEquals(
      capturedArgs[capturedArgs.indexOf("--resume") + 1],
      "prev-session",
    );
  });
});
