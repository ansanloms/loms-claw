import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import assert from "node:assert/strict";
import type { QueryFn } from "../claude/mod.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";
import { Store } from "../store/mod.ts";
import type {
  CommandResult,
  CronExecutorOptions,
  CronPorts,
  RunCommandFn,
} from "./executor.ts";
import { CronExecutor, runShellCommand } from "./executor.ts";
import type { CronCommandJob, CronJobDef } from "./types.ts";

/**
 * `:memory:` DB を持つ Store を生成し、関数実行後に必ず close する。
 * これにより DB ハンドルのリークを防ぐ。
 */
async function withStore(
  fn: (store: Store) => Promise<void> | void,
): Promise<void> {
  const db = new DatabaseSync(":memory:");
  const store = new Store(db, {});
  try {
    await fn(store);
  } finally {
    store.close();
  }
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
 * 最小限のモック CronPorts。
 *
 * `channel` が null のときは `resolveTarget()` が「見つからない」エラーで
 * reject する。`createCanUseTool()` が呼ばれた際の channelId 引数と、返された
 * コールバックが実際に呼ばれた際の channelId を `approvalCalls` に記録する
 * (コールバックは常に allow を返す)。
 */
function createMockPorts(
  channel: { send(content: string): Promise<void> } | null = null,
): CronPorts & {
  approvalCalls: { channelId: string | undefined }[];
  signals: AbortSignal[];
} {
  const approvalCalls: { channelId: string | undefined }[] = [];
  const signals: AbortSignal[] = [];
  return {
    approvalCalls,
    signals,
    resolveTarget(channelId: string) {
      if (!channel) {
        return Promise.reject(
          new Error(`channel ${channelId} not found or not a text channel`),
        );
      }
      return Promise.resolve(channel);
    },
    guildTemplateVars() {
      return {
        "discord.guild.id": "guild-1",
        "discord.guild.name": "test-guild",
      };
    },
    createCanUseTool(channelId: string | undefined, signal: AbortSignal) {
      signals.push(signal);
      return () => {
        approvalCalls.push({ channelId });
        return Promise.resolve({ behavior: "allow", updatedInput: {} });
      };
    },
  };
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
function successQueryFn(result = "test result", sessionId = "test-session") {
  return mockQueryFn([
    {
      type: "result",
      subtype: "success",
      result,
      session_id: sessionId,
      is_error: false,
    },
  ]);
}

/**
 * askClaude に渡された canUseTool を 1 回呼び出してから成功レスポンスを返す
 * mock queryFn。ApprovalManager.requestApproval が実行される経路を作るために使う。
 */
function canUseToolQueryFn(): QueryFn {
  return (params: Parameters<QueryFn>[0]) => {
    async function* gen(): AsyncGenerator<SDKMessage> {
      await params.options?.canUseTool?.(
        "Bash",
        { command: "ls" },
        {
          signal: new AbortController().signal,
          toolUseID: "tu-1",
          requestId: "req-1",
        },
      );
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

/** `CronExecutor` を生成する。引数で上書きしない項目はテスト用の既定値を使う。 */
function createExecutor(
  overrides: Partial<CronExecutorOptions> & {
    ports: CronPorts;
    store: Store;
  },
): CronExecutor {
  return new CronExecutor({
    config: TEST_CONFIG,
    env: { DISCORD_BOT_TOKEN: "test-token" },
    defaults: {},
    systemPrompts: createMockSystemPromptStore(),
    queryFn: mockQueryFn([]),
    ...overrides,
  });
}

/** `query()` に渡された options を記録しつつ成功レスポンスを返す mock queryFn。 */
function capturingQueryFn(): {
  fn: QueryFn;
  calls: NonNullable<Parameters<QueryFn>[0]["options"]>[];
} {
  const calls: NonNullable<Parameters<QueryFn>[0]["options"]>[] = [];
  const fn: QueryFn = (params) => {
    if (params.options) {
      calls.push(params.options);
    }
    return successQueryFn()(params);
  };
  return { fn, calls };
}

/** `resolve()` の引数を記録し、固定のシステムプロンプトを返すモック。 */
function recordingSystemPromptStore(): {
  store: SystemPromptStore;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const store = {
    resolve: (...args: unknown[]) => {
      calls.push(args);
      return "resolved-prompt";
    },
    load: () => Promise.resolve(),
  } as unknown as SystemPromptStore;
  return { store, calls };
}

describe("CronExecutor: prompt ジョブの options 解決", () => {
  const baseJob: CronJobDef = {
    kind: "prompt",
    name: "resolve-job",
    schedule: "0 0 * * *",
    prompt: "hello",
    channelId: "ch-1",
  };

  test("frontmatter の model/effort/maxTurns がチャンネル設定・defaults より優先されること", () =>
    withStore(async (store) => {
      await store.applyPatch(
        { channelId: "ch-1" },
        { model: "channel-model", effort: "low" },
      );
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        defaults: { model: "default-model", effort: "medium" },
        queryFn: fn,
      });

      await executor.runJob({
        ...baseJob,
        model: "job-model",
        effort: "high",
        maxTurns: 3,
      });

      assert.deepStrictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].model, "job-model");
      assert.deepStrictEqual(calls[0].effort, "high");
      assert.deepStrictEqual(calls[0].maxTurns, 3);
    }));

  test("frontmatter が無ければチャンネル設定が defaults より優先されること", () =>
    withStore(async (store) => {
      await store.applyPatch(
        { channelId: "ch-1" },
        { model: "channel-model", effort: "low" },
      );
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        defaults: { model: "default-model", effort: "medium" },
        queryFn: fn,
      });

      await executor.runJob(baseJob);

      assert.deepStrictEqual(calls[0].model, "channel-model");
      assert.deepStrictEqual(calls[0].effort, "low");
      // maxTurns はジョブ指定が無いので config の値のまま
      assert.deepStrictEqual(calls[0].maxTurns, TEST_CONFIG.maxTurns);
    }));

  test("どちらも無ければ defaults が使われること", () =>
    withStore(async (store) => {
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        defaults: { model: "default-model", effort: "medium" },
        queryFn: fn,
      });

      await executor.runJob(baseJob);

      assert.deepStrictEqual(calls[0].model, "default-model");
      assert.deepStrictEqual(calls[0].effort, "medium");
    }));

  test("systemPrompts.resolve に cron・スコープ・ギルドのみの変数が渡り、結果が append されること", () =>
    withStore(async (store) => {
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const prompts = recordingSystemPromptStore();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        systemPrompts: prompts.store,
        queryFn: fn,
      });

      await executor.runJob(baseJob);

      assert.deepStrictEqual(prompts.calls, [
        [
          "cron",
          { channelId: "ch-1" },
          { "discord.guild.id": "guild-1", "discord.guild.name": "test-guild" },
        ],
      ]);
      assert.deepStrictEqual(calls[0].systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "resolved-prompt",
      });
    }));
});

describe("CronExecutor: prompt ジョブの失敗通知", () => {
  const job: CronJobDef = {
    kind: "prompt",
    name: "notify-job",
    schedule: "0 0 * * *",
    prompt: "hello",
    channelId: "ch-1",
  };

  test("result イベントが無いとき [cron: name] 付きで通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        queryFn: mockQueryFn([]),
      });

      assert.deepStrictEqual(await executor.runJob(job), "failed");
      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].startsWith("[cron: notify-job] "), true);
    }));

  test("error_max_turns で result が無いとき [cron: name] 付きで通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        queryFn: mockQueryFn([
          {
            type: "result",
            subtype: "error_max_turns",
            session_id: "s",
            is_error: true,
          },
        ]),
      });

      assert.deepStrictEqual(await executor.runJob(job), "failed");
      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].startsWith("[cron: notify-job] "), true);
    }));
});

describe("CronExecutor", () => {
  test("重複実行がスキップされること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);

      const { promise: gate, resolve: resolveGate } =
        Promise.withResolvers<void>();
      const resultText = "first-run-result";

      const executor = createExecutor({
        ports,
        store,
        queryFn: mockQueryFn(
          [
            {
              type: "result",
              subtype: "success",
              result: resultText,
              session_id: "first-run-session",
              is_error: false,
            },
          ],
          gate,
        ),
      });

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
        assert.deepStrictEqual(executor.isRunning("test-job"), true);

        // 実行中の 2 回目はガードで即座に return すること。
        // await で直接待つと、ガードが壊れて待ち続けた場合にテストがハング
        // するため、タイムアウトと race させてアサーション失敗に落とす。
        let timeoutId!: ReturnType<typeof setTimeout>;
        const raced = await Promise.race<string>([
          executor.runJob(job).then((r) => `returned:${r}`),
          new Promise<string>((resolve) => {
            timeoutId = setTimeout(() => resolve("timeout"), 1000);
          }),
        ]);
        clearTimeout(timeoutId);
        assert.deepStrictEqual(
          raced,
          "returned:skipped",
          "2 回目の runJob はガードで即座に return すること",
        );
      } finally {
        // アサーション失敗時も 1 回目の実行をブロックしたままにしないため、
        // 必ずガードを解除する。
        resolveGate();
      }

      // ブロックを解除して 1 回目を完了させる
      assert.deepStrictEqual(await firstRun, "succeeded");
      assert.deepStrictEqual(sent.includes(resultText), true);
      assert.deepStrictEqual(sent.length, 1); // 2 回目は何も投稿しない
      assert.deepStrictEqual(executor.isRunning("test-job"), false);
    }));

  test("チャンネルが見つからない場合にエラー処理されること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: mockQueryFn([]),
      });

      const job: CronJobDef = {
        kind: "prompt",
        name: "bad-channel-job",
        schedule: "0 0 * * *",
        prompt: "hello",
        channelId: "nonexistent",
      };

      assert.deepStrictEqual(await executor.runJob(job), "failed");

      // running Set から除去されていること
      assert.deepStrictEqual(executor.isRunning("bad-channel-job"), false);
    }));

  test("start/stop でスケジューラが制御されること", () =>
    withStore((store) => {
      const { channel } = createMockChannel();
      const ports = createMockPorts(channel);

      const executor = createExecutor({
        ports,
        store,
        queryFn: mockQueryFn([]),
      });

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
    }));

  test("reload でジョブが差し替えられること", () =>
    withStore((store) => {
      const { channel } = createMockChannel();
      const ports = createMockPorts(channel);

      const executor = createExecutor({
        ports,
        store,
        queryFn: mockQueryFn([]),
      });

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
    }));

  test("セッションキーが cron:{name} 形式であること", () =>
    withStore(async (store) => {
      await store.setSession({ channelId: "cron:my-job" }, "session-abc");
      assert.deepStrictEqual(
        await store.getSession({ channelId: "cron:my-job" }),
        "session-abc",
      );
    }));

  test("resumeSession: true のジョブ実行後、session_id が cron:{name} スコープに保存されること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: successQueryFn("result", "session-xyz"),
      });

      const job: CronJobDef = {
        kind: "prompt",
        name: "resume-job",
        schedule: "0 0 * * *",
        prompt: "hello",
        resumeSession: true,
      };

      assert.deepStrictEqual(await executor.runJob(job), "succeeded");
      assert.deepStrictEqual(
        await store.getSession({ channelId: "cron:resume-job" }),
        "session-xyz",
      );
    }));

  for (const [label, reset] of [
    [
      "applyPatch(session: null)",
      (store: Store) =>
        store.applyPatch({ channelId: "cron:reset-job" }, { session: null }),
    ],
    [
      "clearScope",
      (store: Store) => store.clearScope({ channelId: "cron:reset-job" }),
    ],
  ] as const) {
    test(`resumeSession: true のジョブ実行中に ${label} でリセットされても、結果の受信後にセッションが復活しないこと`, () =>
      withStore(async (store) => {
        await store.setSession({ channelId: "cron:reset-job" }, "old-session");
        const { promise: gate, resolve: resolveGate } =
          Promise.withResolvers<void>();
        const executor = createExecutor({
          ports: createMockPorts(null),
          store,
          queryFn: mockQueryFn(
            [
              {
                type: "result",
                subtype: "success",
                result: "r",
                session_id: "new-session",
                is_error: false,
              },
            ],
            gate,
          ),
        });
        const running = executor.runJob({
          kind: "prompt",
          name: "reset-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          resumeSession: true,
        });
        await reset(store);
        resolveGate();
        assert.deepStrictEqual(await running, "succeeded");
        assert.deepStrictEqual(
          await store.getSession({ channelId: "cron:reset-job" }),
          undefined,
        );
      }));
  }

  for (const [label, reset] of [
    [
      "applyPatch(session: null)",
      (store: Store) =>
        store.applyPatch({ channelId: "cron:fresh-job" }, { session: null }),
    ],
    [
      "clearScope",
      (store: Store) => store.clearScope({ channelId: "cron:fresh-job" }),
    ],
  ] as const) {
    test(`セッション無しで始まった resumeSession: true の実行中に ${label} でリセットされても、結果の受信後にセッションが作られないこと`, () =>
      withStore(async (store) => {
        const { promise: gate, resolve: resolveGate } =
          Promise.withResolvers<void>();
        const executor = createExecutor({
          ports: createMockPorts(null),
          store,
          queryFn: mockQueryFn(
            [
              {
                type: "result",
                subtype: "success",
                result: "r",
                session_id: "new-session",
                is_error: false,
              },
            ],
            gate,
          ),
        });
        const running = executor.runJob({
          kind: "prompt",
          name: "fresh-job",
          schedule: "0 0 * * *",
          prompt: "hello",
          resumeSession: true,
        });
        await reset(store);
        resolveGate();
        assert.deepStrictEqual(await running, "succeeded");
        assert.deepStrictEqual(
          await store.getSession({ channelId: "cron:fresh-job" }),
          undefined,
        );
      }));
  }

  test("resumeSession: true で既存セッションがあれば、再開して新しい session_id に更新されること", () =>
    withStore(async (store) => {
      await store.setSession({ channelId: "cron:upd-job" }, "old-session");
      const executor = createExecutor({
        ports: createMockPorts(null),
        store,
        queryFn: successQueryFn("result", "new-session"),
      });
      await executor.runJob({
        kind: "prompt",
        name: "upd-job",
        schedule: "0 0 * * *",
        prompt: "hello",
        resumeSession: true,
      });
      assert.deepStrictEqual(
        await store.getSession({ channelId: "cron:upd-job" }),
        "new-session",
      );
    }));

  test("resumeSession: false のジョブ実行後は session が保存されないこと", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: successQueryFn("result", "session-xyz"),
      });

      const job: CronJobDef = {
        kind: "prompt",
        name: "no-resume-job",
        schedule: "0 0 * * *",
        prompt: "hello",
        resumeSession: false,
      };

      await executor.runJob(job);
      assert.deepStrictEqual(
        await store.getSession({ channelId: "cron:no-resume-job" }),
        undefined,
      );
    }));

  test("once: true のジョブ実行後にコールバックが呼ばれること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: successQueryFn(),
      });

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
      assert.deepStrictEqual(calledWith, ["once-job"]);
    }));

  test("once: false のジョブではコールバックが呼ばれないこと", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: successQueryFn(),
      });

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
      assert.deepStrictEqual(calledWith, []);
    }));

  test("findJob / listJobs でジョブが取得できること", () =>
    withStore((store) => {
      const { channel } = createMockChannel();
      const ports = createMockPorts(channel);

      const executor = createExecutor({
        ports,
        store,
        queryFn: mockQueryFn([]),
      });

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

      assert.deepStrictEqual(executor.findJob("j1")?.name, "j1");
      const j2 = executor.findJob("j2");
      assert.deepStrictEqual(
        j2?.kind === "prompt" ? j2.prompt : undefined,
        "test2",
      );
      assert.deepStrictEqual(executor.findJob("nonexistent"), undefined);
      assert.deepStrictEqual(executor.listJobs().length, 2);

      executor.stop();
    }));

  test("once: true でコールバック未設定の場合にサイレントスキップされること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: successQueryFn(),
      });

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
      assert.deepStrictEqual(executor.isRunning("once-no-callback"), false);
    }));

  test("once ジョブ実行後に running がコールバック完了後にクリアされること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: successQueryFn(),
      });

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
      assert.deepStrictEqual(runningDuringCallback, true);
      // 完了後はクリアされている
      assert.deepStrictEqual(executor.isRunning("once-running-check"), false);
    }));

  test("cron ジョブの承認リクエストが job.channelId 宛に送られること", () =>
    withStore(async (store) => {
      const { channel } = createMockChannel();
      const ports = createMockPorts(channel);

      const executor = createExecutor({
        ports,
        store,
        queryFn: canUseToolQueryFn(),
      });

      const job: CronJobDef = {
        kind: "prompt",
        name: "approval-job",
        schedule: "0 0 * * *",
        prompt: "hello",
        channelId: "ch-approval",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(ports.approvalCalls, [
        { channelId: "ch-approval" },
      ]);
    }));

  test("channelId の無いジョブでは undefined が渡ること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);

      const executor = createExecutor({
        ports,
        store,
        queryFn: canUseToolQueryFn(),
      });

      const job: CronJobDef = {
        kind: "prompt",
        name: "approval-job-no-channel",
        schedule: "0 0 * * *",
        prompt: "hello",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(ports.approvalCalls, [{ channelId: undefined }]);
    }));

  test("command job: exit 0 + stdout ありで channelId に投稿されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn({
        code: 0,
        stdout: "command result",
        stderr: "",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job",
        schedule: "0 0 * * *",
        command: "echo hello",
        channelId: "ch-cmd",
      };

      assert.deepStrictEqual(await executor.runJob(job), "succeeded");

      assert.deepStrictEqual(sent, ["command result"]);
    }));

  test("command job: stdout が空なら投稿されないこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn({ code: 0, stdout: "", stderr: "" });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-empty",
        schedule: "0 0 * * *",
        command: "true",
        channelId: "ch-cmd",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(sent, []);
    }));

  test("command job: channelId 無しなら投稿されず runCommandFn は呼ばれること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      const { fn, calls } = mockRunCommandFn({
        code: 0,
        stdout: "command result",
        stderr: "",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-no-channel",
        schedule: "0 0 * * *",
        command: "echo hello",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(calls.length, 1);
    }));

  test("command job: 非 0 終了でエラー通知が送られ、runJob 自体は throw しないこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn({
        code: 1,
        stdout: "",
        stderr: "boom",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-fail",
        schedule: "0 0 * * *",
        command: "false",
        channelId: "ch-cmd",
      };

      assert.deepStrictEqual(await executor.runJob(job), "failed");

      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(
        sent[0].startsWith("[cron: command-job-fail] "),
        true,
      );
    }));

  test("command job: 非 0 終了時に stdout があっても通知文面に混ざらないこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn({
        code: 1,
        stdout: "leaked stdout content",
        stderr: "boom",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-fail-stdout",
        schedule: "0 0 * * *",
        command: "false",
        channelId: "ch-cmd",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(
        sent[0],
        "[cron: command-job-fail-stdout] 処理に失敗した。詳細はログ (`GET /logs`) を参照\ncommand exited with code 1: boom",
      );
      assert.deepStrictEqual(sent[0].includes("leaked stdout content"), false);
    }));

  test("command job: once: true で onceCallback がジョブ名で呼ばれること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      const { fn } = mockRunCommandFn({ code: 0, stdout: "", stderr: "" });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

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

      assert.deepStrictEqual(calledWith, ["command-once-job"]);
    }));

  test("command job: signal の abort を待ってから返すモックが timeout 1ms で timeout エラーとして通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn(
        { code: -1, stdout: "should not be posted", stderr: "" },
        { waitForAbort: true },
      );

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-timeout",
        schedule: "0 0 * * *",
        command: "sleep 10",
        channelId: "ch-cmd",
        timeout: 1,
      };

      await executor.runJob(job);

      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(
        sent[0].includes("command timed out after 1ms"),
        true,
      );
    }));

  test("command job: signal の abort を待って reject するモックが timeout 1ms で timeout エラーとして通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn(
        { code: 0, stdout: "should not be posted", stderr: "" },
        { rejectOnAbort: true },
      );

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-timeout-reject",
        schedule: "0 0 * * *",
        command: "sleep 10",
        channelId: "ch-cmd",
        timeout: 1,
      };

      await executor.runJob(job);

      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(
        sent[0].includes("command timed out after 1ms"),
        true,
      );
    }));

  test("command job: abort していない reject はそのままのメッセージで通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn(
        { code: 0, stdout: "", stderr: "" },
        { rejectWith: new Error("spawn failed") },
      );

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-spawn-fail",
        schedule: "0 0 * * *",
        command: "echo hello",
        channelId: "ch-cmd",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].includes("spawn failed"), true);
      assert.deepStrictEqual(sent[0].includes("command timed out"), false);
    }));

  test("command job: cwd に config.cwd が渡ること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      const { fn, calls } = mockRunCommandFn({
        code: 0,
        stdout: "",
        stderr: "",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-cwd",
        schedule: "0 0 * * *",
        command: "pwd",
      };

      await executor.runJob(job);

      assert.deepStrictEqual(calls, [{ command: "pwd", cwd: TEST_CONFIG.cwd }]);
    }));

  test("command job: 2000 文字超の stdout が全文のまま 1 回 target に渡されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const longOutput = "a".repeat(2500);
      const { fn } = mockRunCommandFn({
        code: 0,
        stdout: longOutput,
        stderr: "",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-long",
        schedule: "0 0 * * *",
        command: "echo long",
        channelId: "ch-cmd",
      };

      await executor.runJob(job);

      // メッセージ長に合わせた分割は port 実装 (client) の責務。
      assert.deepStrictEqual(sent, [longOutput]);
    }));

  test("command job: 4000 文字超の stdout が切り詰められ注記が付くこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const overLimitOutput = "b".repeat(4500);
      const { fn } = mockRunCommandFn({
        code: 0,
        stdout: overLimitOutput,
        stderr: "",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-truncated",
        schedule: "0 0 * * *",
        command: "echo huge",
        channelId: "ch-cmd",
      };

      await executor.runJob(job);

      const posted = sent.join("");
      assert.deepStrictEqual(posted.includes("b".repeat(4000)), true);
      assert.deepStrictEqual(
        posted.includes("... (truncated, 4500 chars)"),
        true,
      );
      assert.deepStrictEqual(posted.length < overLimitOutput.length, true);
    }));

  test("command job: 4000 文字ちょうどの stdout は切り詰められないこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const exactOutput = "c".repeat(4000);
      const { fn } = mockRunCommandFn({
        code: 0,
        stdout: exactOutput,
        stderr: "",
      });

      const executor = createExecutor({ ports, store, runCommandFn: fn });

      const job: CronCommandJob = {
        kind: "command",
        name: "command-job-exact-limit",
        schedule: "0 0 * * *",
        command: "echo exact",
        channelId: "ch-cmd",
      };

      await executor.runJob(job);

      const posted = sent.join("");
      assert.deepStrictEqual(posted, exactOutput);
      assert.deepStrictEqual(posted.includes("truncated"), false);
    }));

  const optionsJob: CronJobDef = {
    kind: "prompt",
    name: "resolve-job",
    schedule: "0 0 * * *",
    prompt: "hello",
    channelId: "ch-1",
  };

  test("prompt job: frontmatter の model/effort/maxTurns がチャンネル設定・defaults より優先されること", () =>
    withStore(async (store) => {
      await store.applyPatch(
        { channelId: "ch-1" },
        { model: "channel-model", effort: "low" },
      );
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        defaults: { model: "default-model", effort: "medium" },
        queryFn: fn,
      });

      await executor.runJob({
        ...optionsJob,
        model: "job-model",
        effort: "high",
        maxTurns: 3,
      });

      assert.deepStrictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0].model, "job-model");
      assert.deepStrictEqual(calls[0].effort, "high");
      assert.deepStrictEqual(calls[0].maxTurns, 3);
    }));

  test("prompt job: frontmatter が無ければチャンネル設定が defaults より優先されること", () =>
    withStore(async (store) => {
      await store.applyPatch(
        { channelId: "ch-1" },
        { model: "channel-model", effort: "low" },
      );
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        defaults: { model: "default-model", effort: "medium" },
        queryFn: fn,
      });

      await executor.runJob(optionsJob);

      assert.deepStrictEqual(calls[0].model, "channel-model");
      assert.deepStrictEqual(calls[0].effort, "low");
      // maxTurns はジョブ指定が無いので config の値のまま
      assert.deepStrictEqual(calls[0].maxTurns, TEST_CONFIG.maxTurns);
    }));

  test("prompt job: どちらも無ければ defaults が使われること", () =>
    withStore(async (store) => {
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        defaults: { model: "default-model", effort: "medium" },
        queryFn: fn,
      });

      await executor.runJob(optionsJob);

      assert.deepStrictEqual(calls[0].model, "default-model");
      assert.deepStrictEqual(calls[0].effort, "medium");
    }));

  test("prompt job: systemPrompts.resolve に cron・スコープ・ギルドのみの変数が渡り、結果が append されること", () =>
    withStore(async (store) => {
      const { channel } = createMockChannel();
      const { fn, calls } = capturingQueryFn();
      const prompts = recordingSystemPromptStore();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        systemPrompts: prompts.store,
        queryFn: fn,
      });

      await executor.runJob(optionsJob);

      assert.deepStrictEqual(prompts.calls, [
        [
          "cron",
          { channelId: "ch-1" },
          { "discord.guild.id": "guild-1", "discord.guild.name": "test-guild" },
        ],
      ]);
      assert.deepStrictEqual(calls[0].systemPrompt, {
        type: "preset",
        preset: "claude_code",
        append: "resolved-prompt",
      });
    }));

  const notifyJob: CronJobDef = {
    kind: "prompt",
    name: "notify-job",
    schedule: "0 0 * * *",
    prompt: "hello",
    channelId: "ch-1",
  };

  test("prompt job: result イベントが無いとき [cron: name] 付きで通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        queryFn: mockQueryFn([]),
      });

      assert.deepStrictEqual(await executor.runJob(notifyJob), "failed");
      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].startsWith("[cron: notify-job] "), true);
    }));

  test("prompt job: error_max_turns で result が無いとき [cron: name] 付きで通知されること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const executor = createExecutor({
        ports: createMockPorts(channel),
        store,
        queryFn: mockQueryFn([
          {
            type: "result",
            subtype: "error_max_turns",
            session_id: "s",
            is_error: true,
          },
        ]),
      });

      assert.deepStrictEqual(await executor.runJob(notifyJob), "failed");
      assert.deepStrictEqual(sent.length, 1);
      assert.deepStrictEqual(sent[0].startsWith("[cron: notify-job] "), true);
    }));
});

/** `options.abortController` の abort を待って reject する mock queryFn。 */
function abortAwareQueryFn(started: { resolve: () => void }): QueryFn {
  return (params: Parameters<QueryFn>[0]) => {
    async function* gen(): AsyncGenerator<SDKMessage> {
      const signal = params.options?.abortController?.signal;
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        if (!signal || signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      yield* [];
    }
    return gen() as unknown as ReturnType<QueryFn>;
  };
}

describe("CronExecutor: 終了時の中断", () => {
  test("実行中の command ジョブが stop() で中断され、失敗通知が投稿されず failed を返すこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn(
        { code: -1, stdout: "should not be posted", stderr: "" },
        { waitForAbort: true },
      );
      const executor = createExecutor({ ports, store, runCommandFn: fn });
      const job: CronCommandJob = {
        kind: "command",
        name: "shutdown-command",
        schedule: "0 0 * * *",
        command: "sleep 10",
        channelId: "ch-cmd",
      };

      const running = executor.runJob(job);
      await new Promise((r) => setImmediate(r));
      executor.stop();

      assert.deepStrictEqual(await running, "failed");
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(executor.isRunning(job.name), false);
    }));

  test("実行中の prompt ジョブが stop() で中断され、失敗通知が投稿されず failed を返すこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      let markStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        markStarted = r;
      });
      const executor = createExecutor({
        ports,
        store,
        queryFn: abortAwareQueryFn({ resolve: markStarted }),
      });
      const job: CronJobDef = {
        kind: "prompt",
        name: "shutdown-prompt",
        schedule: "0 0 * * *",
        prompt: "hello",
        channelId: "ch-prompt",
      };

      const running = executor.runJob(job);
      await startedPromise;
      executor.stop();

      assert.deepStrictEqual(await running, "failed");
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(executor.isRunning(job.name), false);
    }));

  test("stop() の後の runJob が skipped を返し、ジョブを実行しないこと", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      const { fn, calls } = mockRunCommandFn({
        code: 0,
        stdout: "",
        stderr: "",
      });
      const executor = createExecutor({ ports, store, runCommandFn: fn });
      executor.stop();

      const result = await executor.runJob({
        kind: "command",
        name: "after-stop",
        schedule: "0 0 * * *",
        command: "true",
      });

      assert.deepStrictEqual(result, "skipped");
      assert.deepStrictEqual(calls, []);
      assert.deepStrictEqual(executor.isRunning("after-stop"), false);
    }));

  test("once ジョブが stop() で中断されたとき onceCallback が呼ばれないこと", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      const { fn } = mockRunCommandFn(
        { code: -1, stdout: "", stderr: "" },
        { waitForAbort: true },
      );
      const executor = createExecutor({ ports, store, runCommandFn: fn });
      const calledWith: string[] = [];
      executor.setOnceCallback((name: string) => {
        calledWith.push(name);
        return Promise.resolve();
      });

      const running = executor.runJob({
        kind: "command",
        name: "once-shutdown",
        schedule: "0 0 * * *",
        command: "sleep 10",
        once: true,
      });
      await new Promise((r) => setImmediate(r));
      executor.stop();

      assert.deepStrictEqual(await running, "failed");
      assert.deepStrictEqual(calledWith, []);
    }));

  test("once ジョブが通常の失敗をしたときは onceCallback が呼ばれること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      const { fn } = mockRunCommandFn(
        { code: 0, stdout: "", stderr: "" },
        { rejectWith: new Error("boom") },
      );
      const executor = createExecutor({ ports, store, runCommandFn: fn });
      const calledWith: string[] = [];
      executor.setOnceCallback((name: string) => {
        calledWith.push(name);
        return Promise.resolve();
      });

      const result = await executor.runJob({
        kind: "command",
        name: "once-fail",
        schedule: "0 0 * * *",
        command: "false",
        once: true,
      });

      assert.deepStrictEqual(result, "failed");
      assert.deepStrictEqual(calledWith, ["once-fail"]);
    }));

  test("rejectOnAbort の command ジョブが stop() で中断されたとき、通知が投稿されず timeout 文言にならないこと", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      const { fn } = mockRunCommandFn(
        { code: 0, stdout: "", stderr: "" },
        { rejectOnAbort: true },
      );
      const executor = createExecutor({ ports, store, runCommandFn: fn });
      const logged: string[] = [];
      const original = console.error;
      const originalLog = console.log;
      const capture = (...args: unknown[]) => {
        logged.push(args.map((a) => String(a)).join(" "));
      };
      console.error = capture;
      console.log = capture;
      try {
        const running = executor.runJob({
          kind: "command",
          name: "reject-shutdown",
          schedule: "0 0 * * *",
          command: "sleep 10",
          channelId: "ch-cmd",
        });
        await new Promise((r) => setImmediate(r));
        executor.stop();

        assert.deepStrictEqual(await running, "failed");
      } finally {
        console.error = original;
        console.log = originalLog;
      }
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(
        logged.some((l) => l.includes("command timed out after")),
        false,
      );
    }));

  test("resolveTarget の待機中に stop() が入ったとき、コマンドも query も始めず通知も onceCallback も無いこと", () =>
    withStore(async (store) => {
      for (const kind of ["command", "prompt"] as const) {
        const { channel, sent } = createMockChannel();
        const base = createMockPorts(channel);
        let release!: () => void;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        const ports: CronPorts = {
          ...base,
          resolveTarget: async (channelId) => {
            await gate;
            return base.resolveTarget(channelId);
          },
        };
        const { fn, calls } = mockRunCommandFn({
          code: 0,
          stdout: "out",
          stderr: "",
        });
        let queryCalls = 0;
        const executor = createExecutor({
          ports,
          store,
          runCommandFn: fn,
          queryFn: (params) => {
            queryCalls++;
            return successQueryFn()(params);
          },
        });
        const calledWith: string[] = [];
        executor.setOnceCallback((name: string) => {
          calledWith.push(name);
          return Promise.resolve();
        });
        const job: CronJobDef =
          kind === "command"
            ? {
                kind,
                name: "wait-target-cmd",
                schedule: "0 0 * * *",
                command: "echo hi",
                channelId: "ch",
                once: true,
              }
            : {
                kind,
                name: "wait-target-prompt",
                schedule: "0 0 * * *",
                prompt: "hello",
                channelId: "ch",
                once: true,
              };

        const running = executor.runJob(job);
        await new Promise((r) => setImmediate(r));
        executor.stop();
        release();

        assert.deepStrictEqual(await running, "failed", kind);
        assert.deepStrictEqual(calls, [], kind);
        assert.deepStrictEqual(queryCalls, 0, kind);
        assert.deepStrictEqual(sent, [], kind);
        assert.deepStrictEqual(calledWith, [], kind);
      }
    }));

  test("終了コード 0 で resolve する直前に stop() が入ったとき、succeeded で出力が投稿され onceCallback が呼ばれること", () =>
    withStore(async (store) => {
      const { channel, sent } = createMockChannel();
      const ports = createMockPorts(channel);
      let finish!: () => void;
      const gate = new Promise<void>((r) => {
        finish = r;
      });
      const fn: RunCommandFn = async () => {
        await gate;
        return { code: 0, stdout: "done\n", stderr: "" };
      };
      const executor = createExecutor({ ports, store, runCommandFn: fn });
      const calledWith: string[] = [];
      executor.setOnceCallback((name: string) => {
        calledWith.push(name);
        return Promise.resolve();
      });

      const running = executor.runJob({
        kind: "command",
        name: "complete-at-stop",
        schedule: "0 0 * * *",
        command: "echo done",
        channelId: "ch",
        once: true,
      });
      await new Promise((r) => setImmediate(r));
      executor.stop();
      finish();

      assert.deepStrictEqual(await running, "succeeded");
      assert.deepStrictEqual(sent, ["done"]);
      assert.deepStrictEqual(calledWith, ["complete-at-stop"]);
    }));

  test("stop() で createCanUseTool に渡された signal が aborted になること", () =>
    withStore(async (store) => {
      const ports = createMockPorts(null);
      let markStarted!: () => void;
      const startedPromise = new Promise<void>((r) => {
        markStarted = r;
      });
      const executor = createExecutor({
        ports,
        store,
        queryFn: abortAwareQueryFn({ resolve: markStarted }),
      });

      const running = executor.runJob({
        kind: "prompt",
        name: "signal-record",
        schedule: "0 0 * * *",
        prompt: "hello",
      });
      await startedPromise;
      assert.deepStrictEqual(ports.signals.length, 1);
      assert.deepStrictEqual(ports.signals[0].aborted, false);
      executor.stop();

      assert.deepStrictEqual(ports.signals[0].aborted, true);
      await running;
    }));
});

describe("runShellCommand", () => {
  test("既に aborted の signal ではコマンドを実行せずに reject すること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    try {
      const controller = new AbortController();
      controller.abort();

      await assert.rejects(
        runShellCommand("touch created.txt", {
          cwd: dir,
          signal: controller.signal,
        }),
        { message: "command timed out" },
      );
      // spawn されていれば touch が走る猶予を与えてから確認する。
      await new Promise((r) => setTimeout(r, 200));
      await assert.rejects(access(join(dir, "created.txt")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
