import { assertEquals, assertThrows } from "@std/assert";
import { join } from "jsr:@std/path@^1/join";
import { loadCronJobsFromDir, validateCronJob } from "./loader.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function writeCronFile(
  workspaceDir: string,
  filename: string,
  content: string,
): Promise<void> {
  const cronDir = join(workspaceDir, ".claude", "cron");
  await Deno.mkdir(cronDir, { recursive: true });
  await Deno.writeTextFile(join(cronDir, filename), content);
}

const VALID_MD = `---
name: test-job
schedule: "0 9 * * *"
channelId: "123456"
description: テストジョブ
---

テストプロンプト。
`;

Deno.test("validateCronJob", async (t) => {
  await t.step("有効なメタデータと本文でジョブが作成されること", () => {
    const job = validateCronJob(
      {
        name: "test",
        schedule: "0 9 * * *",
        channelId: "123",
        description: "desc",
        maxTurns: 5,
        timeout: 60000,
      },
      "prompt text",
      "test.md",
    );
    assertEquals(job.name, "test");
    assertEquals(job.schedule, "0 9 * * *");
    assertEquals(job.channelId, "123");
    assertEquals(job.description, "desc");
    assertEquals(job.prompt, "prompt text");
    assertEquals(job.maxTurns, 5);
    assertEquals(job.timeout, 60000);
  });

  await t.step("channelId が数値の場合に文字列に変換されること", () => {
    const job = validateCronJob(
      { name: "test", schedule: "0 9 * * *", channelId: 123456 },
      "prompt",
      "test.md",
    );
    assertEquals(job.channelId, "123456");
  });

  await t.step("channelId なしでもジョブが作成されること", () => {
    const job = validateCronJob(
      { name: "no-channel", schedule: "0 9 * * *" },
      "prompt text",
      "test.md",
    );
    assertEquals(job.name, "no-channel");
    assertEquals(job.channelId, undefined);
  });

  await t.step("必須フィールドが欠けている場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *" },
          "prompt",
          "test.md",
        ),
      Error,
      '"name" is required',
    );
  });

  await t.step("本文が空の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { name: "test", schedule: "0 9 * * *", channelId: "123" },
          "",
          "test.md",
        ),
      Error,
      "prompt body is empty",
    );
  });

  await t.step("不正な cron 式でエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { name: "test", schedule: "bad", channelId: "123" },
          "prompt",
          "test.md",
        ),
      Error,
      "invalid cron expression",
    );
  });

  await t.step("maxTurns が数値でない場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          {
            name: "test",
            schedule: "0 9 * * *",
            channelId: "123",
            maxTurns: "bad",
          },
          "prompt",
          "test.md",
        ),
      Error,
      '"maxTurns" must be a number',
    );
  });
});

Deno.test("loadCronJobsFromDir", async (t) => {
  await t.step("ディレクトリ不在で空配列を返すこと", async () => {
    await withTempDir(async (dir) => {
      const jobs = await loadCronJobsFromDir(dir);
      assertEquals(jobs, []);
    });
  });

  await t.step("有効なファイルを読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "test-job.md", VALID_MD);
      const jobs = await loadCronJobsFromDir(dir);
      assertEquals(jobs.length, 1);
      assertEquals(jobs[0].name, "test-job");
      assertEquals(jobs[0].prompt, "テストプロンプト。");
    });
  });

  await t.step("複数ファイルを読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "job-1.md", VALID_MD);
      await writeCronFile(
        dir,
        "job-2.md",
        `---
name: job-2
schedule: "0 18 * * *"
channelId: "789"
---

夕方のプロンプト。
`,
      );
      const jobs = await loadCronJobsFromDir(dir);
      assertEquals(jobs.length, 2);
    });
  });

  await t.step(".md 以外のファイルは無視されること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "test-job.md", VALID_MD);
      await writeCronFile(dir, "notes.txt", "just a text file");
      const jobs = await loadCronJobsFromDir(dir);
      assertEquals(jobs.length, 1);
    });
  });

  await t.step("不正なファイルはスキップされること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "good.md", VALID_MD);
      await writeCronFile(dir, "bad.md", "no frontmatter here");
      const jobs = await loadCronJobsFromDir(dir);
      assertEquals(jobs.length, 1);
      assertEquals(jobs[0].name, "test-job");
    });
  });

  await t.step(
    "名前が重複するファイルは後のものがスキップされること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronFile(dir, "a.md", VALID_MD);
        await writeCronFile(
          dir,
          "b.md",
          VALID_MD, // 同じ name: test-job
        );
        const jobs = await loadCronJobsFromDir(dir);
        assertEquals(jobs.length, 1);
      });
    },
  );
});
