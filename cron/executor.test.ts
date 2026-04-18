import { assertEquals } from "@std/assert";
import { CronExecutor } from "./executor.ts";
import type { CronJobDef } from "./types.ts";
import { Store } from "../store/mod.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";

/**
 * `:memory:` KV を持つ Store を生成し、関数実行後に必ず close する。
 * これにより Deno test の sanitizer が "database" リソースリークと
 * 判定するのを防ぐ。
 */
async function withStore(
  fn: (store: Store) => Promise<void> | void,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const store = new Store(kv, {});
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

/** 最小限のモック Client。 */
function createMockClient(
  channel: { send(content: string): Promise<void> } | null = null,
) {
  return {
    channels: {
      fetch(_id: string) {
        if (!channel) {
          return Promise.resolve(null);
        }
        return Promise.resolve(channel);
      },
    },
    guilds: {
      cache: {
        get(_id: string) {
          return { name: "test-guild" };
        },
      },
    },
  };
}

/** 送信されたメッセージを記録するモックチャンネル。 */
function createMockChannel() {
  const sent: string[] = [];
  return {
    channel: {
      send(content: string) {
        sent.push(content);
        return Promise.resolve();
      },
    },
    sent,
  };
}

/** 最小限のモック ApprovalManager。 */
function createMockApprovalManager() {
  let channelId: string | undefined;
  return {
    manager: {
      setChannel(id: string) {
        channelId = id;
      },
    },
    getChannelId: () => channelId,
  };
}

/** 最小限のモック SystemPromptStore。 */
function createMockSystemPromptStore(): SystemPromptStore {
  return {
    resolve: () => undefined,
    load: () => Promise.resolve(),
  } as unknown as SystemPromptStore;
}

/** NDJSON ストリームを返すモック CommandSpawner。 */
function mockSpawner(
  lines: Record<string, unknown>[],
  exitCode = 0,
) {
  return () => ({
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        const ndjson = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
        controller.enqueue(new TextEncoder().encode(ndjson));
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

/** askClaude が成功レスポンスを返す mockSpawner。 */
function successSpawner(
  result = "test result",
  sessionId = "test-session",
) {
  return mockSpawner([{
    type: "result",
    subtype: "success",
    result,
    session_id: sessionId,
    is_error: false,
  }]);
}

const TEST_CONFIG = {
  maxTurns: 10,
  verbose: true,
  timeout: 30000,
  cwd: "/tmp",
  apiPort: 3000,
  defaults: {},
};

Deno.test("CronExecutor", async (t) => {
  await t.step(
    "重複実行がスキップされること",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          mockSpawner([]),
        );

        const job: CronJobDef = {
          name: "test-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          channelId: "ch-123",
        };

        // running Set に追加して重複実行をシミュレート
        // @ts-ignore: private フィールドへのアクセス
        executor.running.add("test-job");
        await executor.runJob(job);
        assertEquals(sent.length, 0); // スキップされる

        // @ts-ignore: private フィールドへのアクセス
        executor.running.delete("test-job");
      }),
  );

  await t.step(
    "チャンネルが見つからない場合にエラー処理されること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          mockSpawner([]),
        );

        const job: CronJobDef = {
          name: "bad-channel-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          channelId: "nonexistent",
        };

        await executor.runJob(job);

        // running Set から除去されていること
        // @ts-ignore: private フィールドへのアクセス
        assertEquals(executor.running.has("bad-channel-job"), false);
      }),
  );

  await t.step(
    "承認先チャンネルが正しく設定されること",
    () =>
      withStore(async (store) => {
        const { channel } = createMockChannel();
        const client = createMockClient(channel);
        const { manager, getChannelId } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          successSpawner(),
        );

        const job: CronJobDef = {
          name: "approval-test",
          schedule: "0 0 * * *",
          prompt: "hello",
          channelId: "ch-approval",
        };

        await executor.runJob(job);
        assertEquals(getChannelId(), "ch-approval");
      }),
  );

  await t.step(
    "channelId なしで承認先チャンネルが設定されないこと",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager, getChannelId } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          successSpawner(),
        );

        const job: CronJobDef = {
          name: "no-channel-job",
          schedule: "0 0 * * *",
          prompt: "hello",
        };

        await executor.runJob(job);
        assertEquals(getChannelId(), undefined);
      }),
  );

  await t.step(
    "start/stop でスケジューラが制御されること",
    () =>
      withStore((store) => {
        const { channel } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          mockSpawner([]),
        );

        const jobs: CronJobDef[] = [
          { name: "j1", schedule: "0 9 * * *", prompt: "test", channelId: "1" },
        ];

        executor.start(jobs);
        executor.stop();
      }),
  );

  await t.step(
    "reload でジョブが差し替えられること",
    () =>
      withStore((store) => {
        const { channel } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          mockSpawner([]),
        );

        executor.start([
          {
            name: "old",
            schedule: "0 9 * * *",
            prompt: "test",
            channelId: "1",
          },
        ]);

        executor.reload([
          {
            name: "new",
            schedule: "0 18 * * *",
            prompt: "test2",
            channelId: "2",
          },
        ]);

        executor.stop();
      }),
  );

  await t.step(
    "セッションキーが cron:{name} 形式であること",
    () =>
      withStore(async (store) => {
        await store.setSession("cron:my-job", "session-abc");
        assertEquals(await store.getSession("cron:my-job"), "session-abc");
      }),
  );

  await t.step(
    "once: true のジョブ実行後にコールバックが呼ばれること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          successSpawner(),
        );

        const calledWith: string[] = [];
        executor.setOnceCallback((name: string) => {
          calledWith.push(name);
          return Promise.resolve();
        });

        const job: CronJobDef = {
          name: "once-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          once: true,
        };

        await executor.runJob(job);
        assertEquals(calledWith, ["once-job"]);
      }),
  );

  await t.step(
    "once: false のジョブではコールバックが呼ばれないこと",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          successSpawner(),
        );

        const calledWith: string[] = [];
        executor.setOnceCallback((name: string) => {
          calledWith.push(name);
          return Promise.resolve();
        });

        const job: CronJobDef = {
          name: "normal-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          once: false,
        };

        await executor.runJob(job);
        assertEquals(calledWith, []);
      }),
  );

  await t.step(
    "findJob / listJobs でジョブが取得できること",
    () =>
      withStore((store) => {
        const { channel } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          mockSpawner([]),
        );

        const jobs: CronJobDef[] = [
          { name: "j1", schedule: "0 9 * * *", prompt: "test1" },
          { name: "j2", schedule: "0 18 * * *", prompt: "test2" },
        ];

        executor.start(jobs);

        assertEquals(executor.findJob("j1")?.name, "j1");
        assertEquals(executor.findJob("j2")?.prompt, "test2");
        assertEquals(executor.findJob("nonexistent"), undefined);
        assertEquals(executor.listJobs().length, 2);

        executor.stop();
      }),
  );

  await t.step(
    "once: true でコールバック未設定の場合にサイレントスキップされること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          successSpawner(),
        );

        // setOnceCallback を呼ばない
        const job: CronJobDef = {
          name: "once-no-callback",
          schedule: "0 0 * * *",
          prompt: "hello",
          once: true,
        };

        // エラーにならずに完了すること
        await executor.runJob(job);

        // running からクリアされていること
        // @ts-ignore: private フィールドへのアクセス
        assertEquals(executor.running.has("once-no-callback"), false);
      }),
  );

  await t.step(
    "once ジョブ実行後に running がコールバック完了後にクリアされること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          store,
          {},
          manager as never,
          systemPrompts,
          successSpawner(),
        );

        let runningDuringCallback = false;
        executor.setOnceCallback((name: string) => {
          // コールバック実行中は running に残っているはず
          // @ts-ignore: private フィールドへのアクセス
          runningDuringCallback = executor.running.has(name);
          return Promise.resolve();
        });

        const job: CronJobDef = {
          name: "once-running-check",
          schedule: "0 0 * * *",
          prompt: "hello",
          once: true,
        };

        await executor.runJob(job);

        // コールバック実行中は running に含まれていた
        assertEquals(runningDuringCallback, true);
        // 完了後はクリアされている
        // @ts-ignore: private フィールドへのアクセス
        assertEquals(executor.running.has("once-running-check"), false);
      }),
  );
});
