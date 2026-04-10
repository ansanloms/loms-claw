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
  const cronDir = join(workspaceDir, "cron");
  await Deno.mkdir(cronDir, { recursive: true });
  await Deno.writeTextFile(join(cronDir, filename), content);
}

const VALID_MD = `---
schedule: "0 9 * * *"
channelId: "123456"
---

テストプロンプト。
`;

Deno.test("validateCronJob", async (t) => {
  await t.step("有効なメタデータと本文でジョブが作成されること", () => {
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
    assertEquals(job.name, "test");
    assertEquals(job.schedule, "0 9 * * *");
    assertEquals(job.channelId, "123");
    assertEquals(job.prompt, "prompt text");
    assertEquals(job.maxTurns, 5);
    assertEquals(job.timeout, 60000);
  });

  await t.step("name がファイル名から .md を除いた値になること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt",
      "daily-summary.md",
    );
    assertEquals(job.name, "daily-summary");
  });

  await t.step("channelId が数値の場合に文字列に変換されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", channelId: 123456 },
      "prompt",
      "test.md",
    );
    assertEquals(job.channelId, "123456");
  });

  await t.step("channelId なしでもジョブが作成されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt text",
      "no-channel.md",
    );
    assertEquals(job.name, "no-channel");
    assertEquals(job.channelId, undefined);
  });

  await t.step("schedule が欠けている場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          {},
          "prompt",
          "test.md",
        ),
      Error,
      '"schedule" is required',
    );
  });

  await t.step("本文が空の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *" },
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
          { schedule: "bad" },
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
            schedule: "0 9 * * *",
            maxTurns: "bad",
          },
          "prompt",
          "test.md",
        ),
      Error,
      '"maxTurns" must be a number',
    );
  });

  await t.step("once: true で正しくパースされること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", once: true },
      "prompt",
      "test.md",
    );
    assertEquals(job.once, true);
  });

  await t.step("once 未指定で false になること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt",
      "test.md",
    );
    assertEquals(job.once, false);
  });

  await t.step(
    "channelId が string でも number でもない場合はエラーになること",
    () => {
      assertThrows(
        () =>
          validateCronJob(
            { schedule: "0 9 * * *", channelId: true },
            "prompt",
            "test.md",
          ),
        Error,
        '"channelId" must be a string or number',
      );
    },
  );

  await t.step("once が boolean でない場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", once: "yes" },
          "prompt",
          "test.md",
        ),
      Error,
      '"once" must be a boolean',
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
      assertEquals(jobs[0].name, "good");
    });
  });
});
