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
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { askClaude, type CommandSpawner } from "../claude/mod.ts";
import type { ClaudeConfig, ClaudeDefaults } from "../config.ts";
import type { Store } from "../store/mod.ts";
import type { ApprovalManager } from "../approval/manager.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";
import { splitMessage } from "../bot/message.ts";
import { createLogger } from "../logger.ts";
import { CronScheduler } from "./scheduler.ts";
import type { CronJobDef } from "./types.ts";

const log = createLogger("cron");

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
    private readonly store: Store,
    private readonly defaults: ClaudeDefaults,
    private readonly approvalManager: ApprovalManager,
    private readonly systemPrompts: SystemPromptStore,
    private readonly spawner?: CommandSpawner,
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
        this.approvalManager.setChannel(job.channelId);
      }

      const sessionKey = `cron:${job.name}`;
      const sessionId = job.resumeSession
        ? await this.store.getSession(sessionKey)
        : undefined;

      // model / effort 解決順: frontmatter > channel 設定 > defaults
      const model = job.model ??
        (job.channelId
          ? await this.store.getModel(job.channelId)
          : undefined) ??
        this.defaults.model;
      const effort = job.effort ??
        (job.channelId
          ? await this.store.getEffort(job.channelId)
          : undefined) ??
        this.defaults.effort;

      // テンプレート変数はギルドレベルのみ（cron にはユーザー/チャンネルコンテキストが無い）
      const guild = this.client.guilds.cache.get(this.guildId);
      const templateVars: Record<string, string> = {
        "discord.guild.id": this.guildId,
        "discord.guild.name": guild?.name ?? "",
      };

      const appendSystemPrompt = this.systemPrompts.resolve(
        "cron",
        job.channelId ?? "",
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
        signal: AbortSignal.timeout(timeout),
        appendSystemPrompt,
        model,
        effort,
        spawner: this.spawner,
      });

      let resultEvent: SDKResultMessage | undefined;

      for await (const event of stream) {
        if (event.type === "result") {
          resultEvent = event;
          if (job.resumeSession) {
            await this.store.setSession(sessionKey, event.session_id);
          }
        }
      }

      if (!resultEvent) {
        throw new Error("claude stream ended without result event");
      }

      if ("result" in resultEvent && typeof resultEvent.result === "string") {
        // channelId 指定時のみ executor が投稿する
        if (textChannel) {
          const chunks = splitMessage(resultEvent.result);
          for (const chunk of chunks) {
            await textChannel.send(chunk);
          }
        }
      } else {
        const errors = "errors" in resultEvent
          ? JSON.stringify(resultEvent.errors)
          : resultEvent.subtype ?? "unknown error";
        throw new Error(`claude returned error: ${errors}`);
      }

      log.info(`cron job "${job.name}" completed`);
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error(`cron job "${job.name}" failed:`, errMsg);

      // channelId 指定時かつチャンネル取得済みならエラーを通知
      if (textChannel) {
        try {
          await textChannel.send(`[cron: ${job.name}] Error: ${errMsg}`);
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
}
