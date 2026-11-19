import { describe, test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const MAIN_PATH = join(import.meta.dirname, "main.ts");

type RunResult = { code: number | null; stderr: string; stdout: string };

/** 一時ディレクトリに config を書き、main.ts を子プロセスで起動して結果を返す。 */
function runMainWithConfig(contents: string | null): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), "loms-claw-main-test-"));
  const path = join(dir, "config.json");
  if (contents !== null) {
    writeFileSync(path, contents);
  }
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [MAIN_PATH],
      {
        env: { ...process.env, LOMS_CLAW_CONFIG: path },
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        const code =
          error === null
            ? 0
            : typeof error.code === "number"
              ? error.code
              : null;
        resolve({ code, stderr, stdout });
      },
    );
  });
}

describe("main", () => {
  test("存在しない config パスで終了コード 1 になり失敗内容が出力されること", async () => {
    const result = await runMainWithConfig(null);
    assert.deepStrictEqual(result.code, 1);
    const output = result.stderr + result.stdout;
    assert.ok(output.includes("failed to load config"));
    assert.ok(output.includes("failed to read config file"));
  });

  test("不正な JSON の config で終了コード 1 になり失敗内容が出力されること", async () => {
    const result = await runMainWithConfig("{bad");
    assert.deepStrictEqual(result.code, 1);
    const output = result.stderr + result.stdout;
    assert.ok(output.includes("failed to load config"));
    assert.ok(output.includes("failed to parse config file"));
  });

  test("スキーマ違反の config で終了コード 1 になり失敗内容が出力されること", async () => {
    const result = await runMainWithConfig(JSON.stringify({ discord: {} }));
    assert.deepStrictEqual(result.code, 1);
    const output = result.stderr + result.stdout;
    assert.ok(output.includes("failed to load config"));
  });
});
