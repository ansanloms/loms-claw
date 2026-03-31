/**
 * cron ジョブのカスタムスケジューラ。
 *
 * 60 秒間隔のインターバルで全ジョブの cron 式を評価し、
 * マッチするジョブのコールバックを実行する。
 *
 * Deno.cron と異なり、ジョブの追加・削除・スケジュール変更を
 * ホットリロードでサポートする。
 *
 * @module
 */

import { matchesCron } from "./match.ts";
import type { CronJobDef } from "./types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("cron-scheduler");

/**
 * tick 間隔（ミリ秒）。
 */
const TICK_INTERVAL_MS = 60_000;

/**
 * cron ジョブのスケジューラ。
 *
 * `replaceAll()` でジョブ定義を差し替えることで、
 * 実行中のスケジューラをホットリロードできる。
 */
export class CronScheduler {
  private jobs = new Map<string, CronJobDef>();
  private timerId: number | null = null;
  private alignTimerId: number | null = null;
  private lastTickMinute = -1;
  private callback: (job: CronJobDef) => void;

  constructor(callback: (job: CronJobDef) => void) {
    this.callback = callback;
  }

  /**
   * 全ジョブ定義を差し替える。実行中のタイマーは維持される。
   */
  replaceAll(jobs: CronJobDef[]): void {
    this.jobs.clear();
    for (const job of jobs) {
      this.jobs.set(job.name, job);
    }
    log.info(`scheduler updated: ${this.jobs.size} job(s)`);
  }

  /**
   * スケジューラを開始する。次の分境界にアラインして tick を開始する。
   *
   * 既に開始済みの場合は何もしない。
   */
  start(): void {
    if (this.timerId !== null || this.alignTimerId !== null) {
      return;
    }

    // 次の分境界までの待機時間を計算
    const now = Date.now();
    const msUntilNextMinute = TICK_INTERVAL_MS - (now % TICK_INTERVAL_MS);

    log.info(`scheduler starting (first tick in ${msUntilNextMinute}ms)`);

    this.alignTimerId = setTimeout(() => {
      this.alignTimerId = null;
      this.tick();
      this.timerId = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    }, msUntilNextMinute);
  }

  /**
   * スケジューラを停止する。
   */
  stop(): void {
    if (this.alignTimerId !== null) {
      clearTimeout(this.alignTimerId);
      this.alignTimerId = null;
    }
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.lastTickMinute = -1;
    log.info("scheduler stopped");
  }

  /**
   * 現在登録されているジョブ数。
   */
  get size(): number {
    return this.jobs.size;
  }

  /**
   * tick 処理。全ジョブの cron 式を評価し、マッチするものを実行する。
   *
   * テスト用に `now` パラメータを受け付ける。
   */
  tick(now?: Temporal.ZonedDateTime): void {
    const zdt = now ?? Temporal.Now.zonedDateTimeISO();
    // epochMinutes をキーにして同一分の二重発火を防止
    const minuteKey = Math.floor(zdt.epochMilliseconds / TICK_INTERVAL_MS);

    if (minuteKey === this.lastTickMinute) {
      return;
    }
    this.lastTickMinute = minuteKey;

    for (const job of this.jobs.values()) {
      try {
        if (matchesCron(job.schedule, zdt)) {
          log.info(`triggering cron job: ${job.name}`);
          this.callback(job);
        }
      } catch (e) {
        log.error(
          `cron match error for "${job.name}":`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }
}
