/**
 * daily-rollup サブコマンド向けの日付 → CivilTimeInterval 変換と 14 日上限検査。
 */

export type CivilDate = { year: number; month: number; day: number };
export type CivilTime = {
  hours: number;
  minutes: number;
  seconds: number;
  nanos: number;
};
export type CivilDateTime = { date: CivilDate; time: CivilTime };
export type CivilTimeInterval = { start: CivilDateTime; end: CivilDateTime };

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIDNIGHT: CivilTime = { hours: 0, minutes: 0, seconds: 0, nanos: 0 };

/**
 * YYYY-MM-DD 形式を検証し、CivilDate に分解する。
 * Date.UTC で組み立てた結果の年月日が入力と一致するかで実在する日付かを検査する
 * (Date.UTC は 2026-02-31 のような不在日付をロールオーバーして解釈してしまうため)。
 */
export function parseCivilDate(value: string): CivilDate {
  if (!DATE_ONLY_RE.test(value)) {
    throw new Error(`日付は YYYY-MM-DD 形式で指定する: ${value}`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new Error(`存在しない日付: ${value}`);
  }
  return { year, month, day };
}

/** CivilDate の翌日を返す (月末・年末をまたぐ計算は UTC 日付演算に委ねる)。 */
export function nextCivilDate(date: CivilDate): CivilDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + 1));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

/** CivilDate 間の日数差 (b - a) を返す。 */
function diffDays(a: CivilDate, b: CivilDate): number {
  const aMs = Date.UTC(a.year, a.month - 1, a.day);
  const bMs = Date.UTC(b.year, b.month - 1, b.day);
  return Math.round((bMs - aMs) / 86_400_000);
}

/**
 * daily-rollup 用の CivilTimeInterval を組み立てる。
 * --to は inclusive として扱い、end は --to の翌日 00:00:00 とする (start は inclusive、end は exclusive)。
 * from が to より後 (from > to) の場合はリクエスト前にエラーにする。
 */
export function buildDailyRollupRange(
  from: string,
  to: string,
): CivilTimeInterval {
  const start = parseCivilDate(from);
  const toDate = parseCivilDate(to);
  if (diffDays(start, toDate) < 0) {
    throw new Error(
      `--from は --to 以前の日付にする (inclusive): from=${from} が to=${to} より後になっている`,
    );
  }
  const end = nextCivilDate(toDate);
  return {
    start: { date: start, time: MIDNIGHT },
    end: { date: end, time: MIDNIGHT },
  };
}

/** daily-rollup で期間 14 日上限が掛かる dataType (issue #77 のドキュメント裏取り結果)。 */
export const DAILY_ROLLUP_14_DAY_LIMIT_TYPES: ReadonlySet<string> = new Set([
  "total-calories",
  "heart-rate",
  "active-minutes",
  "calories-in-heart-rate-zone",
]);

/**
 * dataType が 14 日上限の対象なら、range の日数 (end - start) が maxDays を超えていないか検査する。
 * 対象外の dataType は検査しない。超過時は例外を投げる。
 */
export function checkDailyRollupRangeLimit(
  dataType: string,
  range: CivilTimeInterval,
  maxDays = 14,
): void {
  if (!DAILY_ROLLUP_14_DAY_LIMIT_TYPES.has(dataType)) {
    return;
  }
  const days = diffDays(range.start.date, range.end.date);
  if (days > maxDays) {
    throw new Error(
      `${dataType} は期間が ${maxDays} 日を超えられない (指定: ${days} 日)`,
    );
  }
}
