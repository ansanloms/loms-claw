/**
 * cron ジョブのカスタムスケジューラ。
 *
 * 60 秒間隔のインターバルで全ジョブの cron 式を評価し、
 * マッチするジョブのコールバックを実行する。tick が遅れた場合は、
 * 前回の tick の次の分から現在の分まで（上限 60 分）を遡って評価する。
 *
 * ジョブの追加・削除・スケジュール変更をホットリロードでサポートする
 * (Claude Code 組み込みの CronCreate 等とは無関係)。
 *
 * @module
 */

import { Temporal } from "@js-temporal/polyfill";
import { getErrorMessage } from "../errors.ts";
import { createLogger } from "../logger.ts";
import { matchesCron } from "./match.ts";
import type { CronJobDef } from "./types.ts";

const log = createLogger("cron-scheduler");

/**
 * tick 間隔（ミリ秒）。
 */
const TICK_INTERVAL_MS = 60_000;

/**
 * tick が遅れたときに遡って評価する分数の上限。
 */
const MAX_CATCH_UP_MINUTES = 60;

/**
 * cron ジョブのスケジューラ。
 *
 * `replaceAll()` でジョブ定義を差し替えることで、
 * 実行中のスケジューラをホットリロードできる。
 */
export class CronScheduler {
  private jobs = new Map<string, CronJobDef>();
  private timerId: ReturnType<typeof setInterval> | null = null;
  private alignTimerId: ReturnType<typeof setTimeout> | null = null;
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
    const now = Temporal.Now.instant().epochMilliseconds;
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
   * 名前でジョブを検索する。
   */
  getJob(name: string): CronJobDef | undefined {
    return this.jobs.get(name);
  }

  /**
   * 全ジョブ定義を返す。
   */
  getAllJobs(): CronJobDef[] {
    return [...this.jobs.values()];
  }

  /**
   * tick 処理。全ジョブの cron 式を評価し、マッチするものを実行する。
   *
   * 前回の tick から複数分空いた場合は、間の分（現在の分を含め最大 60 分）も評価する。
   * ジョブは 1 tick につき最大 1 回だけ起動する。初回の tick は現在の分だけを評価する。
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

    // 評価する最初の分。初回と時計の巻き戻りは現在の分だけを見る。
    const fromKey =
      this.lastTickMinute === -1 || minuteKey < this.lastTickMinute
        ? minuteKey
        : Math.max(
            this.lastTickMinute + 1,
            minuteKey - MAX_CATCH_UP_MINUTES + 1,
          );
    this.lastTickMinute = minuteKey;

    const targets: Temporal.ZonedDateTime[] = [];
    for (let key = fromKey; key <= minuteKey; key++) {
      targets.push(zdt.subtract({ minutes: minuteKey - key }));
    }

    for (const job of this.jobs.values()) {
      try {
        if (targets.some((target) => matchesCron(job.schedule, target))) {
          log.info(`triggering cron job: ${job.name}`);
          this.callback(job);
        }
      } catch (e) {
        log.error(`cron match error for "${job.name}":`, getErrorMessage(e));
      }
    }
  }
}
