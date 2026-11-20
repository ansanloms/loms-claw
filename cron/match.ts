/**
 * cron 式のパースとマッチング。
 *
 * パースと一致判定は croner に委ねる。5 フィールド cron（分 時 日 月 曜日）に限定し
 * （`mode: "5-part"`）、日と曜日を両方指定した場合は AND で評価する（`domAndDow: true`）。
 * croner の構文のうち、月名・曜日名、`L`/`W`/`#`/`?`、`@daily` 等のニックネームも通る。
 *
 * @module
 */

import { Temporal } from "@js-temporal/polyfill";
import { Cron } from "croner";

/**
 * croner に渡す共通オプション。
 */
const BASE_OPTIONS = { mode: "5-part", domAndDow: true } as const;

/**
 * 式とタイムゾーンごとの Cron インスタンスのキャッシュ。同じ式を毎分評価するのでキャッシュが有効。
 * callback なしで生成したインスタンスはタイマーを張らない。
 */
const cache = new Map<string, Cron>();

function getCron(rawExpression: string, timezone: string): Cron {
  const expression = rawExpression.trim();
  const key = `${timezone}\n${expression}`;
  let cron = cache.get(key);
  if (!cron) {
    cron = new Cron(expression, { ...BASE_OPTIONS, timezone });
    cache.set(key, cron);
  }
  return cron;
}

/**
 * cron 式の構文を検証する。
 *
 * @throws 構文エラー時。
 */
export function parseCronExpression(expression: string): void {
  const trimmed = expression.trim();
  // croner は ':' を含む文字列を ISO 日時の 1 回きりの予定として受理し、mode を素通りする。
  // 空白区切り 5 フィールドであることを先に確かめる。ニックネーム (@daily 等) は croner が展開する。
  if (!/^@[a-z]+$/i.test(trimmed) && trimmed.split(/\s+/).length !== 5) {
    throw new Error(`cron expression must have 5 fields: "${expression}"`);
  }
  const cron = new Cron(trimmed, BASE_OPTIONS);
  if (cron.nextRun() === null) {
    throw new Error(`cron expression never matches: "${expression}"`);
  }
}

/**
 * 指定された日時が cron 式にマッチするかを判定する。
 *
 * `now` のタイムゾーンで評価する。秒以下は切り捨てて分単位で比較する。
 *
 * @param expression - 5 フィールドの cron 式。
 * @param now - 判定する Temporal.ZonedDateTime。省略時は現在時刻。
 * @returns マッチすれば true。
 * @throws cron 式の構文エラー時。
 */
export function matchesCron(
  expression: string,
  now?: Temporal.ZonedDateTime,
): boolean {
  const zdt = now ?? Temporal.Now.zonedDateTimeISO();
  const minuteStart = zdt.round({
    smallestUnit: "minute",
    roundingMode: "floor",
  });
  // croner の match() は Date しか受け付けない境界なので、ここで Date に変換する。
  return getCron(expression, zdt.timeZoneId).match(
    new Date(minuteStart.epochMilliseconds),
  );
}

/**
 * Cron インスタンスのキャッシュをクリアする（テスト用）。
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Cron インスタンスのキャッシュ件数を返す（テスト用）。
 */
export function cacheSize(): number {
  return cache.size;
}
