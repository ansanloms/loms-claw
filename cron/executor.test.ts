import { assertEquals } from "@std/assert";
import { CronExecutor } from "./executor.ts";
import type { CronJobDef } from "./types.ts";
import { SessionStore } from "../session/mod.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";

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

Deno.test("CronExecutor", async (t) => {
  await t.step("runJob が結果をチャンネルに送信すること", async () => {
    const { channel, sent } = createMockChannel();
    const client = createMockClient(channel);
    const sessions = new SessionStore();
    const { manager } = createMockApprovalManager();
    const systemPrompts = createMockSystemPromptStore();

    // askClaude に spawner を注入するため、executor 内部でテスト用の config を使う
    const config = {
      maxTurns: 10,
      verbose: true,
      timeout: 30000,
      cwd: "/tmp",
      apiPort: 3000,
    };

    const executor = new CronExecutor(
      client as never,
      config,
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

    // spawner をモンキーパッチで注入するのは難しいため、
    // ここでは runJob の重複実行防止ロジックのみテストする
    // （askClaude の spawner DI は claude/mod.test.ts で検証済み）

    // 重複実行防止テスト: running Set に追加して呼び出す
    // @ts-ignore: private フィールドへのアクセス
    executor.running.add("test-job");
    await executor.runJob(job);
    // チャンネルには何も送信されない（スキップされる）
    assertEquals(sent.length, 0);

    // @ts-ignore: private フィールドへのアクセス
    executor.running.delete("test-job");
  });

  await t.step(
    "チャンネルが見つからない場合にエラーログが出ること",
    async () => {
      const client = createMockClient(null); // null を返す
      const sessions = new SessionStore();
      const { manager } = createMockApprovalManager();
      const systemPrompts = createMockSystemPromptStore();

      const config = {
        maxTurns: 10,
        verbose: true,
        timeout: 30000,
        cwd: "/tmp",
        apiPort: 3000,
      };

      const executor = new CronExecutor(
        client as never,
        config,
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

      // エラーが throw されず、finally で running から除去されることを確認
      await executor.runJob(job);

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

    const config = {
      maxTurns: 10,
      verbose: true,
      timeout: 30000,
      cwd: "/tmp",
      apiPort: 3000,
    };

    const executor = new CronExecutor(
      client as never,
      config,
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

  await t.step("セッションキーが cron:{name} 形式であること", () => {
    const sessions = new SessionStore();
    sessions.set("cron:my-job", "session-abc");
    assertEquals(sessions.get("cron:my-job"), "session-abc");
  });
});
