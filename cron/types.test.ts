import { assertEquals, assertRejects } from "@std/assert";
import { join } from "jsr:@std/path@^1/join";
import { loadCronJobs } from "./types.ts";

/**
 * テスト用の一時ディレクトリを作成し、コールバック実行後に削除する。
 */
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

/**
 * .claude/cron.json を書き込む。
 */
async function writeCronJson(
  dir: string,
  content: unknown,
): Promise<void> {
  const claudeDir = join(dir, ".claude");
  await Deno.mkdir(claudeDir, { recursive: true });
  await Deno.writeTextFile(
    join(claudeDir, "cron.json"),
    JSON.stringify(content),
  );
}

Deno.test("loadCronJobs", async (t) => {
  await t.step("cron.json が存在しない場合は空配列を返すこと", async () => {
    await withTempDir(async (dir) => {
      const jobs = await loadCronJobs(dir);
      assertEquals(jobs, []);
    });
  });

  await t.step("有効なジョブ定義を読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronJson(dir, [
        {
          name: "test-job",
          schedule: "0 9 * * *",
          prompt: "hello",
          channelId: "123456",
        },
      ]);
      const jobs = await loadCronJobs(dir);
      assertEquals(jobs.length, 1);
      assertEquals(jobs[0].name, "test-job");
      assertEquals(jobs[0].schedule, "0 9 * * *");
      assertEquals(jobs[0].prompt, "hello");
      assertEquals(jobs[0].channelId, "123456");
      assertEquals(jobs[0].maxTurns, undefined);
      assertEquals(jobs[0].timeout, undefined);
    });
  });

  await t.step("オプションフィールドが読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronJson(dir, [
        {
          name: "job-with-opts",
          schedule: "*/5 * * * *",
          prompt: "test",
          channelId: "999",
          maxTurns: 3,
          timeout: 60000,
        },
      ]);
      const jobs = await loadCronJobs(dir);
      assertEquals(jobs[0].maxTurns, 3);
      assertEquals(jobs[0].timeout, 60000);
    });
  });

  await t.step(
    "name が重複している場合はエラーになること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronJson(dir, [
          {
            name: "dup",
            schedule: "0 0 * * *",
            prompt: "a",
            channelId: "1",
          },
          {
            name: "dup",
            schedule: "0 1 * * *",
            prompt: "b",
            channelId: "2",
          },
        ]);
        await assertRejects(
          () => loadCronJobs(dir),
          Error,
          'duplicate name "dup"',
        );
      });
    },
  );

  await t.step(
    "必須フィールドが欠けている場合はエラーになること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronJson(dir, [
          { name: "no-schedule", prompt: "x", channelId: "1" },
        ]);
        await assertRejects(
          () => loadCronJobs(dir),
          Error,
          '"schedule" is required',
        );
      });
    },
  );

  await t.step(
    "必須フィールドが空文字の場合はエラーになること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronJson(dir, [
          { name: "", schedule: "0 0 * * *", prompt: "x", channelId: "1" },
        ]);
        await assertRejects(
          () => loadCronJobs(dir),
          Error,
          '"name" is required',
        );
      });
    },
  );

  await t.step(
    "JSON が配列でない場合はエラーになること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronJson(dir, { not: "an array" });
        await assertRejects(
          () => loadCronJobs(dir),
          Error,
          "must be a JSON array",
        );
      });
    },
  );

  await t.step(
    "配列要素がオブジェクトでない場合はエラーになること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronJson(dir, ["not an object"]);
        await assertRejects(
          () => loadCronJobs(dir),
          Error,
          "must be an object",
        );
      });
    },
  );

  await t.step(
    "maxTurns が数値でない場合はエラーになること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronJson(dir, [
          {
            name: "bad-turns",
            schedule: "0 0 * * *",
            prompt: "x",
            channelId: "1",
            maxTurns: "not a number",
          },
        ]);
        await assertRejects(
          () => loadCronJobs(dir),
          Error,
          '"maxTurns" must be a number',
        );
      });
    },
  );

  await t.step("空配列は正常に読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronJson(dir, []);
      const jobs = await loadCronJobs(dir);
      assertEquals(jobs, []);
    });
  });

  await t.step("複数ジョブが正しく読み込めること", async () => {
    await withTempDir(async (dir) => {
      await writeCronJson(dir, [
        {
          name: "job-1",
          schedule: "0 9 * * *",
          prompt: "morning",
          channelId: "100",
        },
        {
          name: "job-2",
          schedule: "0 18 * * *",
          prompt: "evening",
          channelId: "200",
        },
      ]);
      const jobs = await loadCronJobs(dir);
      assertEquals(jobs.length, 2);
      assertEquals(jobs[0].name, "job-1");
      assertEquals(jobs[1].name, "job-2");
    });
  });
});
