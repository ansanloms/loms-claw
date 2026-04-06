import { assertEquals } from "@std/assert";
import { CronExecutor } from "./executor.ts";
import type { CronJobDef } from "./types.ts";
import { SessionStore } from "../session/mod.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";

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

const TEST_CONFIG = {
  maxTurns: 10,
  verbose: true,
  timeout: 30000,
  cwd: "/tmp",
  apiPort: 3000,
};

Deno.test("CronExecutor", async (t) => {
  await t.step("重複実行がスキップされること", async () => {
    const { channel, sent } = createMockChannel();
    const client = createMockClient(channel);
    const sessions = new SessionStore();
    const { manager } = createMockApprovalManager();
    const systemPrompts = createMockSystemPromptStore();

    const executor = new CronExecutor(
      client as never,
      TEST_CONFIG,
      "guild-1",
      sessions,
      manager as never,
      systemPrompts,
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
  });

  await t.step(
    "チャンネルが見つからない場合にエラー処理されること",
    async () => {
      const client = createMockClient(null);
      const sessions = new SessionStore();
      const { manager } = createMockApprovalManager();
      const systemPrompts = createMockSystemPromptStore();

      const executor = new CronExecutor(
        client as never,
        TEST_CONFIG,
        "guild-1",
        sessions,
        manager as never,
        systemPrompts,
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
    },
  );

  await t.step("承認先チャンネルが正しく設定されること", async () => {
    const { channel } = createMockChannel();
    const client = createMockClient(channel);
    const sessions = new SessionStore();
    const { manager, getChannelId } = createMockApprovalManager();
    const systemPrompts = createMockSystemPromptStore();

    const executor = new CronExecutor(
      client as never,
      TEST_CONFIG,
      "guild-1",
      sessions,
      manager as never,
      systemPrompts,
    );

    const job: CronJobDef = {
      name: "approval-test",
      schedule: "0 0 * * *",
      prompt: "hello",
      channelId: "ch-approval",
    };

    // runJob はチャンネル取得後に askClaude で失敗するが、
    // setChannel は先に呼ばれる
    await executor.runJob(job);
    assertEquals(getChannelId(), "ch-approval");
  });

  await t.step(
    "channelId なしで承認先チャンネルが設定されないこと",
    async () => {
      const client = createMockClient(null);
      const sessions = new SessionStore();
      const { manager, getChannelId } = createMockApprovalManager();
      const systemPrompts = createMockSystemPromptStore();

      const executor = new CronExecutor(
        client as never,
        TEST_CONFIG,
        "guild-1",
        sessions,
        manager as never,
        systemPrompts,
      );

      const job: CronJobDef = {
        name: "no-channel-job",
        schedule: "0 0 * * *",
        prompt: "hello",
      };

      // askClaude が無いためエラーになるが、setChannel は呼ばれない
      await executor.runJob(job);
      assertEquals(getChannelId(), undefined);
    },
  );

  await t.step("start/stop でスケジューラが制御されること", () => {
    const { channel } = createMockChannel();
    const client = createMockClient(channel);
    const sessions = new SessionStore();
    const { manager } = createMockApprovalManager();
    const systemPrompts = createMockSystemPromptStore();

    const executor = new CronExecutor(
      client as never,
      TEST_CONFIG,
      "guild-1",
      sessions,
      manager as never,
      systemPrompts,
    );

    const jobs: CronJobDef[] = [
      { name: "j1", schedule: "0 9 * * *", prompt: "test", channelId: "1" },
    ];

    executor.start(jobs);
    executor.stop(); // エラーなく停止すること
  });

  await t.step("reload でジョブが差し替えられること", () => {
    const { channel } = createMockChannel();
    const client = createMockClient(channel);
    const sessions = new SessionStore();
    const { manager } = createMockApprovalManager();
    const systemPrompts = createMockSystemPromptStore();

    const executor = new CronExecutor(
      client as never,
      TEST_CONFIG,
      "guild-1",
      sessions,
      manager as never,
      systemPrompts,
    );

    executor.start([
      { name: "old", schedule: "0 9 * * *", prompt: "test", channelId: "1" },
    ]);

    executor.reload([
      { name: "new", schedule: "0 18 * * *", prompt: "test2", channelId: "2" },
    ]);

    executor.stop();
  });

  await t.step("セッションキーが cron:{name} 形式であること", () => {
    const sessions = new SessionStore();
    sessions.set("cron:my-job", "session-abc");
    assertEquals(sessions.get("cron:my-job"), "session-abc");
  });

  await t.step(
    "once: true のジョブ実行後にコールバックが呼ばれること",
    async () => {
      const client = createMockClient(null);
      const sessions = new SessionStore();
      const { manager } = createMockApprovalManager();
      const systemPrompts = createMockSystemPromptStore();

      const executor = new CronExecutor(
        client as never,
        TEST_CONFIG,
        "guild-1",
        sessions,
        manager as never,
        systemPrompts,
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

      // askClaude が無いためエラーになるが、once コールバックは finally で呼ばれる
      await executor.runJob(job);

      // コールバックは非同期で fire-and-forget されるため少し待つ
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(calledWith, ["once-job"]);
    },
  );

  await t.step(
    "once: false のジョブではコールバックが呼ばれないこと",
    async () => {
      const client = createMockClient(null);
      const sessions = new SessionStore();
      const { manager } = createMockApprovalManager();
      const systemPrompts = createMockSystemPromptStore();

      const executor = new CronExecutor(
        client as never,
        TEST_CONFIG,
        "guild-1",
        sessions,
        manager as never,
        systemPrompts,
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
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(calledWith, []);
    },
  );

  await t.step("findJob / listJobs でジョブが取得できること", () => {
    const { channel } = createMockChannel();
    const client = createMockClient(channel);
    const sessions = new SessionStore();
    const { manager } = createMockApprovalManager();
    const systemPrompts = createMockSystemPromptStore();

    const executor = new CronExecutor(
      client as never,
      TEST_CONFIG,
      "guild-1",
      sessions,
      manager as never,
      systemPrompts,
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
  });
});
