/**
 * cron ジョブの実行エンジン。
 *
 * CronScheduler からのコールバックで askClaude() を呼び出す。
 * channelId 指定時は結果テキストを executor が Discord に送信する。
 * channelId 省略時は投稿しない。
 *
 * @module
 */

import type { Client, GuildTextBasedChannel } from "discord.js";
import {
  askClaude,
  drainResultEvent,
  type QueryFn,
  requireResultText,
} from "../claude/mod.ts";
import type { ClaudeConfig, ClaudeDefaults } from "../config.ts";
import type { Store } from "../store/mod.ts";
import { type ApprovalManager, createCanUseTool } from "../approval/manager.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";
import { splitMessage } from "../bot/message.ts";
import { createLogger } from "../logger.ts";
import { CronScheduler } from "./scheduler.ts";
import type { CronCommandJob, CronJobDef, CronPromptJob } from "./types.ts";
import { summarizeErrorForDiscord } from "../errors.ts";

const log = createLogger("cron");

/**
 * command ジョブの stdout を Discord へ投稿する際の文字数上限。
 *
 * Discord メッセージ 2 通分 (`DISCORD_MESSAGE_LIMIT` * 2 相当) を目安にし、
 * 大量出力のコマンドで `channel.send()` が何十通も連発されるのを防ぐ。
 * 超過分は切り詰めて注記を付ける (ログには全量を出す)。
 */
const MAX_COMMAND_OUTPUT_CHARS = 4000;

/** `runCommandFn` (`RunCommandFn`) の実行結果。 */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * command ジョブのコマンド実行を担う関数の型。
 *
 * テスト時に `CronExecutor` のコンストラクタへ DI するために export する。
 */
export type RunCommandFn = (
  command: string,
  options: { cwd: string; signal: AbortSignal },
) => Promise<CommandResult>;

/**
 * `sh -c` でコマンドを実行する既定の `RunCommandFn` 実装。
 *
 * `signal` の abort は `sh` プロセスに SIGTERM を送るだけで、`sh` が起動した
 * 孫プロセスが stdout/stderr の pipe を握ったまま残っていると `output()` が
 * 返らない。そのため `spawn()` で起動し、`child.output()` と「`signal` の
 * abort で reject する Promise」を `Promise.race` する。abort 側が勝ったら
 * `child.kill("SIGTERM")` を呼んで（`sh` 自体は終了させる）reject する。
 */
export const runShellCommand: RunCommandFn = async (
  command,
  { cwd, signal },
) => {
  const child = new Deno.Command("sh", {
    args: ["-c", command],
    cwd,
    signal,
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  let rejectOnAbort!: (error: Error) => void;
  const abortedPromise = new Promise<never>((_, reject) => {
    rejectOnAbort = reject;
  });

  const handleAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // 既に終了しているプロセスへの kill は throw することがあるので握りつぶす
    }
    rejectOnAbort(new Error("command timed out"));
  };

  if (signal.aborted) {
    handleAbort();
  } else {
    signal.addEventListener("abort", handleAbort);
  }

  try {
    const { code, stdout, stderr } = await Promise.race([
      child.output(),
      abortedPromise,
    ]);
    const decoder = new TextDecoder();
    return {
      code,
      stdout: decoder.decode(stdout),
      stderr: decoder.decode(stderr),
    };
  } finally {
    signal.removeEventListener("abort", handleAbort);
  }
};

/**
 * cron ジョブの実行を管理するクラス。
 *
 * CronScheduler と連携し、ジョブのライフサイクル（起動・リロード・停止）を制御する。
 */
export class CronExecutor {
  /** 実行中のジョブ名を追跡し、同一ジョブの並行実行を防止する。 */
  private running = new Set<string>();
  private scheduler: CronScheduler;
  private onceCallback?: (jobName: string) => Promise<void>;

  constructor(
    private readonly client: Client,
    private readonly config: ClaudeConfig,
    private readonly guildId: string,
    /** discord skill の curl に渡す bot トークン (query() env へ注入)。 */
    private readonly discordToken: string,
    private readonly store: Store,
    private readonly defaults: ClaudeDefaults,
    private readonly approvalManager: ApprovalManager,
    private readonly systemPrompts: SystemPromptStore,
    private readonly queryFn?: QueryFn,
    private readonly runCommandFn: RunCommandFn = runShellCommand,
  ) {
    this.scheduler = new CronScheduler((job) => this.runJob(job));
  }

  /**
   * once ジョブ実行後に呼ばれるコールバックを設定する。
   *
   * コールバックはジョブ名を受け取り、ファイル削除・リロード等の後処理を行う。
   */
  setOnceCallback(cb: (jobName: string) => Promise<void>): void {
    this.onceCallback = cb;
  }

  /**
   * 指定した名前のジョブが実行中かどうかを返す。
   */
  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  /**
   * 名前でジョブを検索する。
   */
  findJob(name: string): CronJobDef | undefined {
    return this.scheduler.getJob(name);
  }

  /**
   * 登録済みジョブ一覧を返す。
   */
  listJobs(): CronJobDef[] {
    return this.scheduler.getAllJobs();
  }

  /**
   * ジョブを登録してスケジューラを開始する。
   */
  start(jobs: CronJobDef[]): void {
    this.scheduler.replaceAll(jobs);
    this.scheduler.start();
    log.info(`cron executor started with ${jobs.length} job(s)`);
  }

  /**
   * ジョブ定義をホットリロードする。
   *
   * 実行中のジョブは自然に完了する。次回の tick から新しい定義が適用される。
   */
  reload(jobs: CronJobDef[]): void {
    this.scheduler.replaceAll(jobs);
    log.info(`cron executor reloaded with ${jobs.length} job(s)`);
  }

  /**
   * スケジューラを停止する。
   */
  stop(): void {
    this.scheduler.stop();
    log.info("cron executor stopped");
  }

  /**
   * 単一の cron ジョブを実行する。
   *
   * 重複実行防止のため、同名ジョブが既に実行中の場合はスキップする。
   * channelId 指定時: 結果テキストを executor がチャンネルに送信する。
   * channelId 省略時: 投稿しない。
   * `job.kind` で prompt ジョブ ({@link runPromptJob}) と command ジョブ
   * ({@link runCommandJob}) に処理を振り分ける。
   */
  async runJob(job: CronJobDef): Promise<void> {
    if (this.running.has(job.name)) {
      log.warn(`cron job "${job.name}" is already running, skipping`);
      return;
    }

    this.running.add(job.name);
    log.info(`cron job "${job.name}" started`);

    // channelId 指定時はチャンネルを事前取得（catch 内でもエラー通知に使う）
    let textChannel: GuildTextBasedChannel | undefined;

    try {
      if (job.channelId) {
        const channel = await this.client.channels.fetch(job.channelId);
        if (!channel || !("send" in channel)) {
          throw new Error(
            `channel ${job.channelId} not found or not a text channel`,
          );
        }
        textChannel = channel as GuildTextBasedChannel;
      }

      if (job.kind === "command") {
        await this.runCommandJob(job, textChannel);
      } else {
        await this.runPromptJob(job, textChannel);
      }

      log.info(`cron job "${job.name}" completed`);
    } catch (error: unknown) {
      // logger は Error の stack を自動で展開する。全文はここに残す。
      log.error(`cron job "${job.name}" failed:`, error);

      // channelId 指定時かつチャンネル取得済みならエラーを通知 (要約のみ、全文は上記ログ)。
      if (textChannel) {
        try {
          await textChannel.send(
            `[cron: ${job.name}] ${summarizeErrorForDiscord(error)}`,
          );
        } catch {
          // チャンネルへの通知も失敗した場合はログのみ
        }
      }
    } finally {
      if (job.once && this.onceCallback) {
        try {
          await this.onceCallback(job.name);
        } catch (e) {
          log.error(`once callback failed for "${job.name}":`, e);
        }
      }
      this.running.delete(job.name);
    }
  }

  /**
   * prompt ジョブ 1 件を実行する (`askClaude()` → Discord 投稿)。
   */
  private async runPromptJob(
    job: CronPromptJob,
    textChannel: GuildTextBasedChannel | undefined,
  ): Promise<void> {
    const sessionKey = `cron:${job.name}`;

    // session / model / effort は独立した KV 読みなので並列で取得する。
    // (cron はスレッドを持たないので channel スコープのみ)
    const [sessionId, channelModel, channelEffort] = await Promise.all([
      job.resumeSession
        ? this.store.getSession({ channelId: sessionKey })
        : Promise.resolve(undefined),
      job.channelId
        ? this.store.getModel({ channelId: job.channelId })
        : Promise.resolve(undefined),
      job.channelId
        ? this.store.getEffort({ channelId: job.channelId })
        : Promise.resolve(undefined),
    ]);

    // 解決順: frontmatter > channel 設定 > defaults
    const model = job.model ?? channelModel ?? this.defaults.model;
    const effort = job.effort ?? channelEffort ?? this.defaults.effort;

    // テンプレート変数はギルドレベルのみ（cron にはユーザー/チャンネルコンテキストが無い）
    const guild = this.client.guilds.cache.get(this.guildId);
    const templateVars: Record<string, string> = {
      "discord.guild.id": this.guildId,
      "discord.guild.name": guild?.name ?? "",
    };

    const appendSystemPrompt = this.systemPrompts.resolve(
      "cron",
      { channelId: job.channelId ?? "" },
      templateVars,
    );

    const jobConfig: ClaudeConfig = {
      ...this.config,
      ...(job.maxTurns !== undefined ? { maxTurns: job.maxTurns } : {}),
    };
    const timeout = job.timeout ?? this.config.timeout;

    const stream = askClaude(job.prompt, {
      sessionId,
      config: jobConfig,
      discordToken: this.discordToken,
      signal: AbortSignal.timeout(timeout),
      appendSystemPrompt,
      model,
      effort,
      canUseTool: createCanUseTool(this.approvalManager, job.channelId),
      queryFn: this.queryFn,
    });

    const resultEvent = await drainResultEvent(stream, {
      onNonSuccess: (event) =>
        log.warn(
          `cron job "${job.name}" non-success subtype "${event.subtype}":`,
          JSON.stringify(event),
        ),
      setSession: job.resumeSession
        ? (newSessionId) =>
          this.store.setSession({ channelId: sessionKey }, newSessionId)
        : undefined,
    });

    // requireResultText() は textChannel の有無に関わらず先に評価する。
    // result が無い/エラーなら textChannel が無くても throw され、catch で
    // ログされる (取得済みならエラー通知も行われる)。
    const text = requireResultText(resultEvent);
    // channelId 指定時のみ executor が投稿する
    if (textChannel) {
      for (const chunk of splitMessage(text)) {
        await textChannel.send(chunk);
      }
    }
  }

  /**
   * command ジョブ 1 件を実行する (`sh -c` → Discord 投稿)。
   *
   * KV (session / model / effort)・システムプロンプト・承認には触れない。
   */
  private async runCommandJob(
    job: CronCommandJob,
    textChannel: GuildTextBasedChannel | undefined,
  ): Promise<void> {
    const timeout = job.timeout ?? this.config.timeout;
    const signal = AbortSignal.timeout(timeout);

    let result: CommandResult;
    try {
      result = await this.runCommandFn(job.command, {
        cwd: this.config.cwd,
        signal,
      });
    } catch (error) {
      // 本番の runShellCommand は abort 時に素の "command timed out" で
      // reject するため、ここで signal.aborted を見て文書化された
      // メッセージへ載せ替える。abort によらない reject はそのまま投げ直す。
      if (signal.aborted) {
        throw new Error(`command timed out after ${timeout}ms`);
      }
      throw error;
    }

    if (signal.aborted) {
      throw new Error(`command timed out after ${timeout}ms`);
    }

    if (result.code !== 0) {
      if (result.stdout) {
        log.error(`cron job "${job.name}" stdout:`, result.stdout);
      }
      const stderrFirstLine = result.stderr.split(/\r?\n/)[0];
      throw new Error(
        `command exited with code ${result.code}: ${stderrFirstLine}\n${result.stderr}`,
      );
    }

    if (result.stderr) {
      log.warn(`cron job "${job.name}" stderr:`, result.stderr);
    }

    let output = result.stdout.trim();
    if (output.length > MAX_COMMAND_OUTPUT_CHARS) {
      const originalLength = output.length;
      output = `${
        output.slice(0, MAX_COMMAND_OUTPUT_CHARS)
      }\n... (truncated, ${originalLength} chars)`;
    }
    if (output && textChannel) {
      for (const chunk of splitMessage(output)) {
        await textChannel.send(chunk);
      }
    }
  }
}
