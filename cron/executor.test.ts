import { assertEquals } from "@std/assert";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CronExecutor } from "./executor.ts";
import type { CommandResult, RunCommandFn } from "./executor.ts";
import type { CronCommandJob, CronJobDef } from "./types.ts";
import { Store } from "../store/mod.ts";
import type { QueryFn } from "../claude/mod.ts";
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

/**
 * 最小限のモック ApprovalManager。
 *
 * requestApproval が呼ばれた際の channelId 引数を calls に記録する。
 * デフォルトでは allow を返す。
 */
function createMockApprovalManager() {
  const calls: { channelId: string | undefined }[] = [];
  const manager = {
    requestApproval(
      _toolName: string,
      _toolInput: Record<string, unknown>,
      channelId: string | undefined,
    ) {
      calls.push({ channelId });
      return Promise.resolve({ decision: "allow" as const });
    },
  };
  return { manager, calls };
}

/** 最小限のモック SystemPromptStore。 */
function createMockSystemPromptStore(): SystemPromptStore {
  return {
    resolve: () => undefined,
    load: () => Promise.resolve(),
  } as unknown as SystemPromptStore;
}

/**
 * SDKMessage を順に yield するモック queryFn。
 *
 * `gate` を渡すと、最初の yield の前に `await gate` してから yield を始める。
 * ジョブを実行中状態のままブロックさせたいテストで使う。
 */
function mockQueryFn(
  lines: Record<string, unknown>[],
  gate?: Promise<void>,
): QueryFn {
  return (_params: Parameters<QueryFn>[0]) => {
    async function* gen(): AsyncGenerator<SDKMessage> {
      if (gate) {
        await gate;
      }
      for (const line of lines) {
        yield line as unknown as SDKMessage;
      }
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

/** askClaude が成功レスポンスを返す mockQueryFn。 */
function successQueryFn(
  result = "test result",
  sessionId = "test-session",
) {
  return mockQueryFn([{
    type: "result",
    subtype: "success",
    result,
    session_id: sessionId,
    is_error: false,
  }]);
}

/**
 * askClaude に渡された canUseTool を 1 回呼び出してから成功レスポンスを返す
 * mock queryFn。ApprovalManager.requestApproval が実行される経路を作るために使う。
 */
function canUseToolQueryFn(): QueryFn {
  return (params: Parameters<QueryFn>[0]) => {
    async function* gen(): AsyncGenerator<SDKMessage> {
      await params.options?.canUseTool?.("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
        toolUseID: "tu-1",
        requestId: "req-1",
      });
      yield {
        type: "result",
        subtype: "success",
        result: "test result",
        session_id: "test-session",
        is_error: false,
      } as unknown as SDKMessage;
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

/**
 * 固定の CommandResult を返す mock RunCommandFn。
 *
 * 受け取った `command`/`cwd` を calls に記録する。
 * - `waitForAbort: true`: `signal` が abort されるまで待ってから resolve する
 *   （resolve 経路の timeout テストで使う）。
 * - `rejectOnAbort: true`: `signal` が abort されるまで待ってから、本番の
 *   `runShellCommand` と同じ `Error("command timed out")` で reject する
 *   （reject 経路の timeout テストで使う）。
 * - `rejectWith`: 呼び出し即座に指定エラーで reject する
 *   （abort によらない失敗のテストで使う）。
 */
function mockRunCommandFn(
  result: CommandResult,
  options: {
    waitForAbort?: boolean;
    rejectOnAbort?: boolean;
    rejectWith?: Error;
  } = {},
): { fn: RunCommandFn; calls: { command: string; cwd: string }[] } {
  const calls: { command: string; cwd: string }[] = [];
  const fn: RunCommandFn = (command, { cwd, signal }) => {
    calls.push({ command, cwd });
    if (options.rejectWith) {
      return Promise.reject(options.rejectWith);
    }
    if (options.rejectOnAbort) {
      return new Promise<CommandResult>((_resolve, reject) => {
        const rejectTimeout = () => reject(new Error("command timed out"));
        if (signal.aborted) {
          rejectTimeout();
          return;
        }
        signal.addEventListener("abort", rejectTimeout);
      });
    }
    if (!options.waitForAbort) {
      return Promise.resolve(result);
    }
    return new Promise<CommandResult>((resolve) => {
      if (signal.aborted) {
        resolve(result);
        return;
      }
      signal.addEventListener("abort", () => resolve(result));
    });
  };
  return { fn, calls };
}

const TEST_CONFIG = {
  maxTurns: 10,
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

        const { promise: gate, resolve: resolveGate } = Promise
          .withResolvers<void>();
        const resultText = "first-run-result";

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          mockQueryFn([{
            type: "result",
            subtype: "success",
            result: resultText,
            session_id: "first-run-session",
            is_error: false,
          }], gate),
        );

        const job: CronJobDef = {
          kind: "prompt",
          name: "test-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          channelId: "ch-123",
        };

        // 1 回目を実行開始し、running に登録された状態でブロックさせる
        const firstRun = executor.runJob(job);
        try {
          assertEquals(executor.isRunning("test-job"), true);

          // 実行中の 2 回目はガードで即座に return すること。
          // await で直接待つと、ガードが壊れて待ち続けた場合にテストがハング
          // するため、タイムアウトと race させてアサーション失敗に落とす。
          let timeoutId!: ReturnType<typeof setTimeout>;
          const raced = await Promise.race<string>([
            executor.runJob(job).then(() => "returned"),
            new Promise<string>((resolve) => {
              timeoutId = setTimeout(() => resolve("timeout"), 1000);
            }),
          ]);
          clearTimeout(timeoutId);
          assertEquals(
            raced,
            "returned",
            "2 回目の runJob はガードで即座に return すること",
          );
        } finally {
          // アサーション失敗時も 1 回目の実行をブロックしたままにしないため、
          // 必ずガードを解除する。
          resolveGate();
        }

        // ブロックを解除して 1 回目を完了させる
        await firstRun;
        assertEquals(sent.includes(resultText), true);
        assertEquals(sent.length, 1); // 2 回目は何も投稿しない
        assertEquals(executor.isRunning("test-job"), false);
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          mockQueryFn([]),
        );

        const job: CronJobDef = {
          kind: "prompt",
          name: "bad-channel-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          channelId: "nonexistent",
        };

        await executor.runJob(job);

        // running Set から除去されていること
        assertEquals(executor.isRunning("bad-channel-job"), false);
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          mockQueryFn([]),
        );

        const jobs: CronJobDef[] = [
          {
            kind: "prompt",
            name: "j1",
            schedule: "0 9 * * *",
            prompt: "test",
            channelId: "1",
          },
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          mockQueryFn([]),
        );

        executor.start([
          {
            kind: "prompt",
            name: "old",
            schedule: "0 9 * * *",
            prompt: "test",
            channelId: "1",
          },
        ]);

        executor.reload([
          {
            kind: "prompt",
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
        await store.setSession({ channelId: "cron:my-job" }, "session-abc");
        assertEquals(
          await store.getSession({ channelId: "cron:my-job" }),
          "session-abc",
        );
      }),
  );

  await t.step(
    "resumeSession: true のジョブ実行後、session_id が cron:{name} スコープに保存されること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          successQueryFn("result", "session-xyz"),
        );

        const job: CronJobDef = {
          kind: "prompt",
          name: "resume-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          resumeSession: true,
        };

        await executor.runJob(job);
        assertEquals(
          await store.getSession({ channelId: "cron:resume-job" }),
          "session-xyz",
        );
      }),
  );

  await t.step(
    "resumeSession: false のジョブ実行後は session が保存されないこと",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          successQueryFn("result", "session-xyz"),
        );

        const job: CronJobDef = {
          kind: "prompt",
          name: "no-resume-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          resumeSession: false,
        };

        await executor.runJob(job);
        assertEquals(
          await store.getSession({ channelId: "cron:no-resume-job" }),
          undefined,
        );
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          successQueryFn(),
        );

        const calledWith: string[] = [];
        executor.setOnceCallback((name: string) => {
          calledWith.push(name);
          return Promise.resolve();
        });

        const job: CronJobDef = {
          kind: "prompt",
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          successQueryFn(),
        );

        const calledWith: string[] = [];
        executor.setOnceCallback((name: string) => {
          calledWith.push(name);
          return Promise.resolve();
        });

        const job: CronJobDef = {
          kind: "prompt",
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          mockQueryFn([]),
        );

        const jobs: CronJobDef[] = [
          {
            kind: "prompt",
            name: "j1",
            schedule: "0 9 * * *",
            prompt: "test1",
          },
          {
            kind: "prompt",
            name: "j2",
            schedule: "0 18 * * *",
            prompt: "test2",
          },
        ];

        executor.start(jobs);

        assertEquals(executor.findJob("j1")?.name, "j1");
        const j2 = executor.findJob("j2");
        assertEquals(j2?.kind === "prompt" ? j2.prompt : undefined, "test2");
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          successQueryFn(),
        );

        // setOnceCallback を呼ばない
        const job: CronJobDef = {
          kind: "prompt",
          name: "once-no-callback",
          schedule: "0 0 * * *",
          prompt: "hello",
          once: true,
        };

        // エラーにならずに完了すること
        await executor.runJob(job);

        // running からクリアされていること
        assertEquals(executor.isRunning("once-no-callback"), false);
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
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          successQueryFn(),
        );

        let runningDuringCallback = false;
        executor.setOnceCallback((name: string) => {
          // コールバック実行中は running に残っているはず
          runningDuringCallback = executor.isRunning(name);
          return Promise.resolve();
        });

        const job: CronJobDef = {
          kind: "prompt",
          name: "once-running-check",
          schedule: "0 0 * * *",
          prompt: "hello",
          once: true,
        };

        await executor.runJob(job);

        // コールバック実行中は running に含まれていた
        assertEquals(runningDuringCallback, true);
        // 完了後はクリアされている
        assertEquals(executor.isRunning("once-running-check"), false);
      }),
  );

  await t.step(
    "cron ジョブの承認リクエストが job.channelId 宛に送られること",
    () =>
      withStore(async (store) => {
        const { channel } = createMockChannel();
        const client = createMockClient(channel);
        const { manager, calls } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          canUseToolQueryFn(),
        );

        const job: CronJobDef = {
          kind: "prompt",
          name: "approval-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          channelId: "ch-approval",
        };

        await executor.runJob(job);

        assertEquals(calls, [{ channelId: "ch-approval" }]);
      }),
  );

  await t.step(
    "channelId の無いジョブでは undefined が渡ること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager, calls } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          canUseToolQueryFn(),
        );

        const job: CronJobDef = {
          kind: "prompt",
          name: "approval-job-no-channel",
          schedule: "0 0 * * *",
          prompt: "hello",
        };

        await executor.runJob(job);

        assertEquals(calls, [{ channelId: undefined }]);
      }),
  );

  await t.step(
    "command job: exit 0 + stdout ありで channelId に投稿されること",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn({
          code: 0,
          stdout: "command result",
          stderr: "",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job",
          schedule: "0 0 * * *",
          command: "echo hello",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        assertEquals(sent, ["command result"]);
      }),
  );

  await t.step(
    "command job: stdout が空なら投稿されないこと",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn({ code: 0, stdout: "", stderr: "" });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-empty",
          schedule: "0 0 * * *",
          command: "true",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        assertEquals(sent, []);
      }),
  );

  await t.step(
    "command job: channelId 無しなら投稿されず runCommandFn は呼ばれること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn, calls } = mockRunCommandFn({
          code: 0,
          stdout: "command result",
          stderr: "",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-no-channel",
          schedule: "0 0 * * *",
          command: "echo hello",
        };

        await executor.runJob(job);

        assertEquals(calls.length, 1);
      }),
  );

  await t.step(
    "command job: 非 0 終了でエラー通知が送られ、runJob 自体は throw しないこと",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn({
          code: 1,
          stdout: "",
          stderr: "boom",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-fail",
          schedule: "0 0 * * *",
          command: "false",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        assertEquals(sent.length, 1);
        assertEquals(sent[0].startsWith("[cron: command-job-fail] "), true);
      }),
  );

  await t.step(
    "command job: 非 0 終了時に stdout があっても通知文面に混ざらないこと",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn({
          code: 1,
          stdout: "leaked stdout content",
          stderr: "boom",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-fail-stdout",
          schedule: "0 0 * * *",
          command: "false",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        assertEquals(sent.length, 1);
        assertEquals(
          sent[0],
          "[cron: command-job-fail-stdout] 処理に失敗した。詳細はログ (`GET /logs`) を参照\ncommand exited with code 1: boom",
        );
        assertEquals(sent[0].includes("leaked stdout content"), false);
      }),
  );

  await t.step(
    "command job: once: true で onceCallback がジョブ名で呼ばれること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn({ code: 0, stdout: "", stderr: "" });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const calledWith: string[] = [];
        executor.setOnceCallback((name: string) => {
          calledWith.push(name);
          return Promise.resolve();
        });

        const job: CronCommandJob = {
          kind: "command",
          name: "command-once-job",
          schedule: "0 0 * * *",
          command: "true",
          once: true,
        };

        await executor.runJob(job);

        assertEquals(calledWith, ["command-once-job"]);
      }),
  );

  await t.step(
    "command job: signal の abort を待ってから返すモックが timeout 1ms で timeout エラーとして通知されること",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn(
          { code: 0, stdout: "should not be posted", stderr: "" },
          { waitForAbort: true },
        );

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-timeout",
          schedule: "0 0 * * *",
          command: "sleep 10",
          channelId: "ch-cmd",
          timeout: 1,
        };

        await executor.runJob(job);

        assertEquals(sent.length, 1);
        assertEquals(
          sent[0].includes("command timed out after 1ms"),
          true,
        );
      }),
  );

  await t.step(
    "command job: signal の abort を待って reject するモックが timeout 1ms で timeout エラーとして通知されること",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn(
          { code: 0, stdout: "should not be posted", stderr: "" },
          { rejectOnAbort: true },
        );

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-timeout-reject",
          schedule: "0 0 * * *",
          command: "sleep 10",
          channelId: "ch-cmd",
          timeout: 1,
        };

        await executor.runJob(job);

        assertEquals(sent.length, 1);
        assertEquals(
          sent[0].includes("command timed out after 1ms"),
          true,
        );
      }),
  );

  await t.step(
    "command job: abort していない reject はそのままのメッセージで通知されること",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn } = mockRunCommandFn(
          { code: 0, stdout: "", stderr: "" },
          { rejectWith: new Error("spawn failed") },
        );

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-spawn-fail",
          schedule: "0 0 * * *",
          command: "echo hello",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        assertEquals(sent.length, 1);
        assertEquals(sent[0].includes("spawn failed"), true);
        assertEquals(sent[0].includes("command timed out"), false);
      }),
  );

  await t.step(
    "command job: cwd に config.cwd が渡ること",
    () =>
      withStore(async (store) => {
        const client = createMockClient(null);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const { fn, calls } = mockRunCommandFn({
          code: 0,
          stdout: "",
          stderr: "",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-cwd",
          schedule: "0 0 * * *",
          command: "pwd",
        };

        await executor.runJob(job);

        assertEquals(calls, [{ command: "pwd", cwd: TEST_CONFIG.cwd }]);
      }),
  );

  await t.step(
    "command job: 2000 文字超の stdout が分割投稿されること",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const longOutput = "a".repeat(2500);
        const { fn } = mockRunCommandFn({
          code: 0,
          stdout: longOutput,
          stderr: "",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-long",
          schedule: "0 0 * * *",
          command: "echo long",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        assertEquals(sent.length > 1, true);
        assertEquals(sent.join(""), longOutput);
      }),
  );

  await t.step(
    "command job: 4000 文字超の stdout が切り詰められ注記が付くこと",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const overLimitOutput = "b".repeat(4500);
        const { fn } = mockRunCommandFn({
          code: 0,
          stdout: overLimitOutput,
          stderr: "",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-truncated",
          schedule: "0 0 * * *",
          command: "echo huge",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        const posted = sent.join("");
        assertEquals(posted.includes("b".repeat(4000)), true);
        assertEquals(posted.includes("... (truncated, 4500 chars)"), true);
        assertEquals(posted.length < overLimitOutput.length, true);
      }),
  );

  await t.step(
    "command job: 4000 文字ちょうどの stdout は切り詰められないこと",
    () =>
      withStore(async (store) => {
        const { channel, sent } = createMockChannel();
        const client = createMockClient(channel);
        const { manager } = createMockApprovalManager();
        const systemPrompts = createMockSystemPromptStore();
        const exactOutput = "c".repeat(4000);
        const { fn } = mockRunCommandFn({
          code: 0,
          stdout: exactOutput,
          stderr: "",
        });

        const executor = new CronExecutor(
          client as never,
          TEST_CONFIG,
          "guild-1",
          "test-token",
          store,
          {},
          manager as never,
          systemPrompts,
          undefined,
          fn,
        );

        const job: CronCommandJob = {
          kind: "command",
          name: "command-job-exact-limit",
          schedule: "0 0 * * *",
          command: "echo exact",
          channelId: "ch-cmd",
        };

        await executor.runJob(job);

        const posted = sent.join("");
        assertEquals(posted, exactOutput);
        assertEquals(posted.includes("truncated"), false);
      }),
  );
});
