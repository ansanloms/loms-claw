import { describe, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { errorWith } from "../test-helpers.ts";
import { join } from "@std/path/join";
import {
  loadCronJobsFromDir,
  validateCommandJob,
  validateCronJob,
} from "./loader.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true });
  }
}

async function writeCronFile(
  workspaceDir: string,
  filename: string,
  content: string,
): Promise<void> {
  const cronDir = join(workspaceDir, "cron");
  await mkdir(cronDir, { recursive: true });
  await writeFile(join(cronDir, filename), content);
}

const VALID_MD = `---
schedule: "0 9 * * *"
channelId: "123456"
---

テストプロンプト。
`;

describe("validateCronJob", () => {
  test("有効なメタデータと本文でジョブが作成されること", () => {
    const job = validateCronJob(
      {
        schedule: "0 9 * * *",
        channelId: "123",
        maxTurns: 5,
        timeout: 60000,
      },
      "prompt text",
      "test.md",
    );
    assert.deepStrictEqual(job.name, "test.md");
    assert.deepStrictEqual(job.schedule, "0 9 * * *");
    assert.deepStrictEqual(job.channelId, "123");
    assert.deepStrictEqual(job.prompt, "prompt text");
    assert.deepStrictEqual(job.maxTurns, 5);
    assert.deepStrictEqual(job.timeout, 60000);
  });

  test("name がファイル名そのものになること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt",
      "daily-summary.md",
    );
    assert.deepStrictEqual(job.name, "daily-summary.md");
  });

  test("channelId が数値の場合に文字列に変換されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", channelId: 123456 },
      "prompt",
      "test.md",
    );
    assert.deepStrictEqual(job.channelId, "123456");
  });

  test("channelId なしでもジョブが作成されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt text",
      "no-channel.md",
    );
    assert.deepStrictEqual(job.name, "no-channel.md");
    assert.deepStrictEqual(job.channelId, undefined);
  });

  test("schedule が欠けている場合はエラーになること", () => {
    assert.throws(
      () => validateCronJob({}, "prompt", "test.md"),
      errorWith(Error, '"schedule" is required'),
    );
  });

  test("本文が空の場合はエラーになること", () => {
    assert.throws(
      () => validateCronJob({ schedule: "0 9 * * *" }, "", "test.md"),
      errorWith(Error, "prompt body is empty"),
    );
  });

  test("不正な cron 式でエラーになること", () => {
    assert.throws(
      () => validateCronJob({ schedule: "bad" }, "prompt", "test.md"),
      errorWith(Error, "invalid cron expression"),
    );
  });

  test("maxTurns が数値でない場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          {
            schedule: "0 9 * * *",
            maxTurns: "bad",
          },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"maxTurns" must be a number'),
    );
  });

  test("既知フィールドの型違いは is not an allowed property を含まないこと", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", maxTurns: "abc" },
          "prompt",
          "test.md",
        ),
      (e) =>
        e instanceof Error && !e.message.includes("is not an allowed property"),
    );
  });

  test("once: true で正しくパースされること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", once: true },
      "prompt",
      "test.md",
    );
    assert.deepStrictEqual(job.once, true);
  });

  test("once 未指定で false になること", () => {
    const job = validateCronJob({ schedule: "0 9 * * *" }, "prompt", "test.md");
    assert.deepStrictEqual(job.once, false);
  });

  test("channelId が string でも number でもない場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", channelId: true },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"channelId" must be a string or number'),
    );
  });

  test("once が boolean でない場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", once: "yes" },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"once" must be a boolean'),
    );
  });

  test("model 指定でジョブに反映されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", model: "opus" },
      "prompt",
      "test.md",
    );
    assert.deepStrictEqual(job.model, "opus");
  });

  test("effort 指定でジョブに反映されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", effort: "high" },
      "prompt",
      "test.md",
    );
    assert.deepStrictEqual(job.effort, "high");
  });

  test("effort が enum 外の値の場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", effort: "ultra" },
          "prompt",
          "test.md",
        ),
      Error,
    );
  });

  test("未知のフロントマターキーがある場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", chanelId: "123" },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"chanelId" is not an allowed property'),
    );
  });

  test("model / effort を未指定で undefined になること", () => {
    const job = validateCronJob({ schedule: "0 9 * * *" }, "prompt", "test.md");
    assert.deepStrictEqual(job.model, undefined);
    assert.deepStrictEqual(job.effort, undefined);
  });

  test("2^53 超の数値 channelId でエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", channelId: 2 ** 53 + 1 },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"channelId" must be quoted as a string'),
    );
  });

  // 安全な整数の channelId が文字列化されることは
  // 「channelId が数値の場合に文字列に変換されること」で確認済み。

  test("timeout が 0 の場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", timeout: 0 },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"timeout" must be a positive number'),
    );
  });

  test("timeout が負数の場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", timeout: -1 },
          "prompt",
          "test.md",
        ),
      errorWith(Error, '"timeout" must be a positive number'),
    );
  });
});

describe("validateCommandJob", () => {
  test("最小構成 (schedule + command) でジョブが作成されること", () => {
    const job = validateCommandJob(
      { schedule: "0 9 * * *", command: "echo hello" },
      "check.yaml",
    );
    assert.deepStrictEqual(job.kind, "command");
    assert.deepStrictEqual(job.name, "check.yaml");
    assert.deepStrictEqual(job.schedule, "0 9 * * *");
    assert.deepStrictEqual(job.command, "echo hello");
  });

  test("command が欠けている場合はエラーになること", () => {
    assert.throws(
      () => validateCommandJob({ schedule: "0 9 * * *" }, "check.yaml"),
      errorWith(Error, '"command" is required'),
    );
  });

  test("command が空文字の場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "" },
          "check.yaml",
        ),
      (e) =>
        e instanceof Error &&
        e.message.includes(
          '"command" is required and must be a non-empty string',
        ),
    );
  });

  test("prompt 用フィールドを書くと additionalProperties エラーになること", () => {
    assert.throws(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "echo hello", maxTurns: 5 },
          "check.yaml",
        ),
      errorWith(Error, '"maxTurns" is not an allowed property'),
    );
  });

  test("channelId が数値の場合に文字列に変換されること", () => {
    const job = validateCommandJob(
      { schedule: "0 9 * * *", command: "echo hello", channelId: 123456 },
      "check.yaml",
    );
    assert.deepStrictEqual(job.channelId, "123456");
  });

  test("once / timeout が通ること", () => {
    const job = validateCommandJob(
      {
        schedule: "0 9 * * *",
        command: "echo hello",
        once: true,
        timeout: 60000,
      },
      "check.yaml",
    );
    assert.deepStrictEqual(job.once, true);
    assert.deepStrictEqual(job.timeout, 60000);
  });

  test("不正な cron 式でエラーになること", () => {
    assert.throws(
      () =>
        validateCommandJob(
          { schedule: "bad", command: "echo hello" },
          "check.yaml",
        ),
      errorWith(Error, "invalid cron expression"),
    );
  });

  test("2^53 超の数値 channelId でエラーになること", () => {
    assert.throws(
      () =>
        validateCommandJob(
          {
            schedule: "0 9 * * *",
            command: "echo hello",
            channelId: 2 ** 53 + 1,
          },
          "check.yaml",
        ),
      errorWith(Error, '"channelId" must be quoted as a string'),
    );
  });

  // 安全な整数の channelId が文字列化されることは
  // 「channelId が数値の場合に文字列に変換されること」で確認済み。

  test("timeout が 0 の場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "echo hello", timeout: 0 },
          "check.yaml",
        ),
      errorWith(Error, '"timeout" must be a positive number'),
    );
  });

  test("timeout が負数の場合はエラーになること", () => {
    assert.throws(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "echo hello", timeout: -1 },
          "check.yaml",
        ),
      errorWith(Error, '"timeout" must be a positive number'),
    );
  });
});

describe("loadCronJobsFromDir", () => {
  test("ディレクトリ不在で空配列を返すこと", async () => {
    await withTempDir(async (dir) => {
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs, []);
    });
  });

  test("有効なファイルを読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "test-job.md", VALID_MD);
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 1);
      const job = jobs[0];
      assert.deepStrictEqual(job.name, "test-job.md");
      assert.deepStrictEqual(job.kind, "prompt");
      if (job.kind === "prompt") {
        assert.deepStrictEqual(job.prompt, "テストプロンプト。");
      }
    });
  });

  test("複数ファイルを読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "job-1.md", VALID_MD);
      await writeCronFile(
        dir,
        "job-2.md",
        `---
schedule: "0 18 * * *"
channelId: "789"
---

夕方のプロンプト。
`,
      );
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 2);
    });
  });

  test(".md / .yaml 以外のファイルは無視されること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "test-job.md", VALID_MD);
      await writeCronFile(dir, "notes.txt", "just a text file");
      await writeCronFile(
        dir,
        "ignored.yml",
        'schedule: "0 9 * * *"\ncommand: "echo hello"\n',
      );
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 1);
    });
  });

  test("不正なファイルはスキップされること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "good.md", VALID_MD);
      await writeCronFile(dir, "bad.md", "no frontmatter here");
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 1);
      assert.deepStrictEqual(jobs[0].name, "good.md");
    });
  });

  test(".md と .yaml が混在するディレクトリで両方読めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "prompt-job.md", VALID_MD);
      await writeCronFile(
        dir,
        "command-job.yaml",
        'schedule: "0 9 * * *"\ncommand: "echo hello"\n',
      );
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 2);
      const kinds = jobs.map((j) => j.kind).sort();
      assert.deepStrictEqual(kinds, ["command", "prompt"]);
    });
  });

  test("不正な YAML の .yaml がスキップされ他のファイルは読めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "good.md", VALID_MD);
      await writeCronFile(dir, "bad.yaml", "schedule: [unterminated");
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 1);
      assert.deepStrictEqual(jobs[0].name, "good.md");
    });
  });

  test("配列などオブジェクトでない YAML がスキップされること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "array.yaml", "- a\n- b\n");
      const jobs = await loadCronJobsFromDir(dir);
      assert.deepStrictEqual(jobs.length, 0);
    });
  });
});
