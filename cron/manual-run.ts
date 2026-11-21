/**
 * cron ジョブの手動実行 (`POST /cron/run`)。
 *
 * ジョブの存在確認 → レート枠の消費 → 実行の順で処理する。
 * スケジューラによる定時起動はここを通らず、制限の対象外。
 */

import type { CronJobDef, CronRunResult } from "./types.ts";

/** 手動実行の結果。レート制限を超過して実行しなかった場合は `"rate-limited"`。 */
export type ManualRunResult = CronRunResult | "rate-limited";

/** {@link runJobManually} の依存関係。 */
export interface ManualRunDeps {
  /** 名前からジョブ定義を引く。未登録なら undefined。 */
  findJob: (name: string) => CronJobDef | undefined;
  /** ジョブを 1 件実行する。 */
  runJob: (job: CronJobDef) => Promise<CronRunResult>;
  /** 手動実行のレート枠。 */
  limiter: { tryConsume(): boolean };
}

/**
 * 名前を指定してジョブを手動実行する。
 *
 * 枠の消費は存在確認の後、実行の前に行う。未登録の名前では枠を消費しない。
 * 実行が `skipped` になる呼び出し (同名ジョブの実行中、終了処理中) も枠を消費する。
 * skip の判定は `CronExecutor.runJob` の中にあり、消費の前には知る手段が無い。
 * 連鎖の歯止めとしては、試行を数えるほうが安全側である。
 *
 * @param name - 実行するジョブ名。
 * @param deps - 依存関係。
 * @returns 実行結果。枠が尽きていれば `"rate-limited"` (実行しない)。
 * @throws 未登録のジョブ名のとき `job not found: {name}` の Error。
 */
export async function runJobManually(
  name: string,
  deps: ManualRunDeps,
): Promise<ManualRunResult> {
  const job = deps.findJob(name);
  if (!job) {
    throw new Error(`job not found: ${name}`);
  }
  if (!deps.limiter.tryConsume()) {
    return "rate-limited";
  }
  return await deps.runJob(job);
}
