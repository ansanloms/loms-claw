import { assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path/join";
import {
  loadCronJobsFromDir,
  validateCommandJob,
  validateCronJob,
} from "./loader.ts";

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
    assertEquals(job.name, "test.md");
    assertEquals(job.schedule, "0 9 * * *");
    assertEquals(job.channelId, "123");
    assertEquals(job.prompt, "prompt text");
    assertEquals(job.maxTurns, 5);
    assertEquals(job.timeout, 60000);
  });

  await t.step("name がファイル名そのものになること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt",
      "daily-summary.md",
    );
    assertEquals(job.name, "daily-summary.md");
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
    assertEquals(job.name, "no-channel.md");
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

  await t.step(
    "既知フィールドの型違いは is not an allowed property を含まないこと",
    () => {
      let message = "";
      try {
        validateCronJob(
          { schedule: "0 9 * * *", maxTurns: "abc" },
          "prompt",
          "test.md",
        );
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      assertEquals(message.includes("is not an allowed property"), false);
    },
  );

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

  await t.step("model 指定でジョブに反映されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", model: "opus" },
      "prompt",
      "test.md",
    );
    assertEquals(job.model, "opus");
  });

  await t.step("effort 指定でジョブに反映されること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *", effort: "high" },
      "prompt",
      "test.md",
    );
    assertEquals(job.effort, "high");
  });

  await t.step("effort が enum 外の値の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", effort: "ultra" },
          "prompt",
          "test.md",
        ),
      Error,
    );
  });

  await t.step("未知のフロントマターキーがある場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", chanelId: "123" },
          "prompt",
          "test.md",
        ),
      Error,
      '"chanelId" is not an allowed property',
    );
  });

  await t.step("model / effort を未指定で undefined になること", () => {
    const job = validateCronJob(
      { schedule: "0 9 * * *" },
      "prompt",
      "test.md",
    );
    assertEquals(job.model, undefined);
    assertEquals(job.effort, undefined);
  });

  await t.step(
    "2^53 超の数値 channelId でエラーになること",
    () => {
      assertThrows(
        () =>
          validateCronJob(
            { schedule: "0 9 * * *", channelId: 2 ** 53 + 1 },
            "prompt",
            "test.md",
          ),
        Error,
        '"channelId" must be quoted as a string',
      );
    },
  );

  // 安全な整数の channelId が文字列化されることは
  // 「channelId が数値の場合に文字列に変換されること」で確認済み。

  await t.step("timeout が 0 の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", timeout: 0 },
          "prompt",
          "test.md",
        ),
      Error,
      '"timeout" must be a positive number',
    );
  });

  await t.step("timeout が負数の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCronJob(
          { schedule: "0 9 * * *", timeout: -1 },
          "prompt",
          "test.md",
        ),
      Error,
      '"timeout" must be a positive number',
    );
  });
});

Deno.test("validateCommandJob", async (t) => {
  await t.step("最小構成 (schedule + command) でジョブが作成されること", () => {
    const job = validateCommandJob(
      { schedule: "0 9 * * *", command: "echo hello" },
      "check.yaml",
    );
    assertEquals(job.kind, "command");
    assertEquals(job.name, "check.yaml");
    assertEquals(job.schedule, "0 9 * * *");
    assertEquals(job.command, "echo hello");
  });

  await t.step("command が欠けている場合はエラーになること", () => {
    assertThrows(
      () => validateCommandJob({ schedule: "0 9 * * *" }, "check.yaml"),
      Error,
      '"command" is required',
    );
  });

  await t.step("command が空文字の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "" },
          "check.yaml",
        ),
      Error,
      '"command" is required and must be a non-empty string',
    );
  });

  await t.step(
    "prompt 用フィールドを書くと additionalProperties エラーになること",
    () => {
      assertThrows(
        () =>
          validateCommandJob(
            { schedule: "0 9 * * *", command: "echo hello", maxTurns: 5 },
            "check.yaml",
          ),
        Error,
        '"maxTurns" is not an allowed property',
      );
    },
  );

  await t.step("channelId が数値の場合に文字列に変換されること", () => {
    const job = validateCommandJob(
      { schedule: "0 9 * * *", command: "echo hello", channelId: 123456 },
      "check.yaml",
    );
    assertEquals(job.channelId, "123456");
  });

  await t.step("once / timeout が通ること", () => {
    const job = validateCommandJob(
      {
        schedule: "0 9 * * *",
        command: "echo hello",
        once: true,
        timeout: 60000,
      },
      "check.yaml",
    );
    assertEquals(job.once, true);
    assertEquals(job.timeout, 60000);
  });

  await t.step("不正な cron 式でエラーになること", () => {
    assertThrows(
      () =>
        validateCommandJob(
          { schedule: "bad", command: "echo hello" },
          "check.yaml",
        ),
      Error,
      "invalid cron expression",
    );
  });

  await t.step(
    "2^53 超の数値 channelId でエラーになること",
    () => {
      assertThrows(
        () =>
          validateCommandJob(
            {
              schedule: "0 9 * * *",
              command: "echo hello",
              channelId: 2 ** 53 + 1,
            },
            "check.yaml",
          ),
        Error,
        '"channelId" must be quoted as a string',
      );
    },
  );

  // 安全な整数の channelId が文字列化されることは
  // 「channelId が数値の場合に文字列に変換されること」で確認済み。

  await t.step("timeout が 0 の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "echo hello", timeout: 0 },
          "check.yaml",
        ),
      Error,
      '"timeout" must be a positive number',
    );
  });

  await t.step("timeout が負数の場合はエラーになること", () => {
    assertThrows(
      () =>
        validateCommandJob(
          { schedule: "0 9 * * *", command: "echo hello", timeout: -1 },
          "check.yaml",
        ),
      Error,
      '"timeout" must be a positive number',
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
      const job = jobs[0];
      assertEquals(job.name, "test-job.md");
      assertEquals(job.kind, "prompt");
      if (job.kind === "prompt") {
        assertEquals(job.prompt, "テストプロンプト。");
      }
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

  await t.step(".md / .yaml 以外のファイルは無視されること", async () => {
    await withTempDir(async (dir) => {
      await writeCronFile(dir, "test-job.md", VALID_MD);
      await writeCronFile(dir, "notes.txt", "just a text file");
      await writeCronFile(
        dir,
        "ignored.yml",
        'schedule: "0 9 * * *"\ncommand: "echo hello"\n',
      );
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
      assertEquals(jobs[0].name, "good.md");
    });
  });

  await t.step(
    ".md と .yaml が混在するディレクトリで両方読めること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronFile(dir, "prompt-job.md", VALID_MD);
        await writeCronFile(
          dir,
          "command-job.yaml",
          'schedule: "0 9 * * *"\ncommand: "echo hello"\n',
        );
        const jobs = await loadCronJobsFromDir(dir);
        assertEquals(jobs.length, 2);
        const kinds = jobs.map((j) => j.kind).sort();
        assertEquals(kinds, ["command", "prompt"]);
      });
    },
  );

  await t.step(
    "不正な YAML の .yaml がスキップされ他のファイルは読めること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronFile(dir, "good.md", VALID_MD);
        await writeCronFile(dir, "bad.yaml", "schedule: [unterminated");
        const jobs = await loadCronJobsFromDir(dir);
        assertEquals(jobs.length, 1);
        assertEquals(jobs[0].name, "good.md");
      });
    },
  );

  await t.step(
    "配列などオブジェクトでない YAML がスキップされること",
    async () => {
      await withTempDir(async (dir) => {
        await writeCronFile(dir, "array.yaml", "- a\n- b\n");
        const jobs = await loadCronJobsFromDir(dir);
        assertEquals(jobs.length, 0);
      });
    },
  );
});
