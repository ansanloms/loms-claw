/**
 * 自己メンション応答のスライディングウィンドウレートリミッタ。
 *
 * bot 全体で「直近 windowMinutes 分間に maxCount 回まで」を強制する。
 * AI 出力が次の応答を起動する構造の暴走 (ループ・連鎖) に対する機械的な歯止め。
 */
export class SelfMentionRateLimiter {
  private readonly maxCount: number;
  private readonly windowMinutes: number;
  private readonly now: () => Temporal.Instant;
  private timestamps: Temporal.Instant[] = [];

  constructor(
    maxCount: number,
    windowMinutes: number,
    now: () => Temporal.Instant = () => Temporal.Now.instant(),
  ) {
    this.maxCount = maxCount;
    this.windowMinutes = windowMinutes;
    this.now = now;
  }

  /** 1 回分の実行枠を消費する。枠があれば true、レート超過なら false。 */
  tryConsume(): boolean {
    const current = this.now();
    const windowStart = current.subtract({ minutes: this.windowMinutes });
    this.timestamps = this.timestamps.filter(
      (t) => Temporal.Instant.compare(t, windowStart) >= 0,
    );

    if (this.timestamps.length >= this.maxCount) {
      return false;
    }

    this.timestamps.push(current);
    return true;
  }
}
