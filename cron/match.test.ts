import { Temporal } from "@js-temporal/polyfill";
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { errorWith } from "../test-helpers.ts";
import {
  cacheSize,
  clearCache,
  matchesCron,
  parseCronExpression,
} from "./match.ts";

/** テスト用の Temporal.ZonedDateTime を作るヘルパー。 */
function zdt(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz = "Asia/Tokyo",
): Temporal.ZonedDateTime {
  return Temporal.ZonedDateTime.from({
    year,
    month,
    day,
    hour,
    minute,
    second: 0,
    timeZone: tz,
  });
}

describe("matchesCron", () => {
  before(() => {
    clearCache();
  });

  test("'* * * * *' は全ての日時にマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("* * * * *", zdt(2026, 3, 31, 12, 30)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("* * * * *", zdt(2026, 1, 1, 0, 0)),
      true,
    );
  });

  test("固定の分・時にマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("0 9 * * *", zdt(2026, 3, 31, 9, 0)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 * * *", zdt(2026, 3, 31, 9, 1)),
      false,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 * * *", zdt(2026, 3, 31, 10, 0)),
      false,
    );
  });

  test("ステップ式 */N が正しくマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 0)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 15)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 30)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 45)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 7)),
      false,
    );
  });

  test("範囲式 N-M が正しくマッチすること", () => {
    // 月-金（1-5）
    // 2026-03-31 は火曜日（dayOfWeek === 2）
    assert.deepStrictEqual(
      matchesCron("0 9 * * 1-5", zdt(2026, 3, 31, 9, 0)),
      true,
    );
    // 2026-03-29 は日曜日（dayOfWeek === 7 → %7 === 0）
    assert.deepStrictEqual(
      matchesCron("0 9 * * 1-5", zdt(2026, 3, 29, 9, 0)),
      false,
    );
  });

  test("リスト式 N,M,L が正しくマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 5)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 10)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 15)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 6)),
      false,
    );
  });

  test("曜日 0 と 7 が両方とも日曜日として扱われること", () => {
    // 2026-03-29 は日曜日
    assert.deepStrictEqual(
      matchesCron("0 9 * * 0", zdt(2026, 3, 29, 9, 0)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 * * 7", zdt(2026, 3, 29, 9, 0)),
      true,
    );
  });

  test("日・月の固定値がマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("0 9 15 6 *", zdt(2026, 6, 15, 9, 0)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 15 6 *", zdt(2026, 6, 14, 9, 0)),
      false,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 15 6 *", zdt(2026, 7, 15, 9, 0)),
      false,
    );
  });

  test("毎月1日 00:00 がマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("0 0 1 * *", zdt(2026, 4, 1, 0, 0)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("0 0 1 * *", zdt(2026, 4, 2, 0, 0)),
      false,
    );
  });

  test("年末の境界値がマッチすること", () => {
    assert.deepStrictEqual(
      matchesCron("59 23 31 12 *", zdt(2026, 12, 31, 23, 59)),
      true,
    );
  });

  test("範囲 + ステップが正しくマッチすること", () => {
    // 1-5/2 → 1, 3, 5
    assert.deepStrictEqual(
      matchesCron("0 9 * * 1-5/2", zdt(2026, 3, 30, 9, 0)),
      true,
    ); // 月曜=1
    assert.deepStrictEqual(
      matchesCron("0 9 * * 1-5/2", zdt(2026, 3, 31, 9, 0)),
      false,
    ); // 火曜=2
    assert.deepStrictEqual(
      matchesCron("0 9 * * 1-5/2", zdt(2026, 4, 1, 9, 0)),
      true,
    ); // 水曜=3
  });

  test("全フィールド組み合わせがマッチすること", () => {
    // 毎月15日 09:30 の月曜日
    // 2026-06-15 は月曜日
    assert.deepStrictEqual(
      matchesCron("30 9 15 6 1", zdt(2026, 6, 15, 9, 30)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("30 9 15 6 1", zdt(2026, 6, 15, 9, 31)),
      false,
    );
  });

  test("異なるタイムゾーンで正しく評価されること", () => {
    // UTC 09:00 は Asia/Tokyo では 18:00
    const utcNine = zdt(2026, 3, 31, 9, 0, "UTC");
    const jstEighteen = zdt(2026, 3, 31, 18, 0, "Asia/Tokyo");

    assert.deepStrictEqual(matchesCron("0 9 * * *", utcNine), true);
    assert.deepStrictEqual(matchesCron("0 18 * * *", jstEighteen), true);
    assert.deepStrictEqual(matchesCron("0 9 * * *", jstEighteen), false);
  });

  test("日と曜日を両方指定した式は AND で評価されること", () => {
    // 2026-06-15 は月曜日、2026-06-22 も月曜日だが 15 日ではない
    assert.deepStrictEqual(
      matchesCron("0 9 15 6 1", zdt(2026, 6, 15, 9, 0)),
      true,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 15 6 1", zdt(2026, 6, 22, 9, 0)),
      false,
    );
    assert.deepStrictEqual(
      matchesCron("0 9 15 6 1", zdt(2026, 6, 16, 9, 0)),
      false,
    );
  });

  test("秒が 0 でない時刻でも分単位で一致すること", () => {
    const t = Temporal.ZonedDateTime.from({
      year: 2026,
      month: 3,
      day: 31,
      hour: 9,
      minute: 0,
      second: 37,
      millisecond: 500,
      timeZone: "Asia/Tokyo",
    });
    assert.deepStrictEqual(matchesCron("0 9 * * *", t), true);
    assert.deepStrictEqual(matchesCron("1 9 * * *", t), false);
  });

  test("前後に空白のある式でも一致判定できること", () => {
    assert.deepStrictEqual(
      matchesCron("  0 9 * * *  ", zdt(2026, 3, 31, 9, 0)),
      true,
    );
  });

  test("ニックネームが使えること", () => {
    assert.deepStrictEqual(matchesCron("@daily", zdt(2026, 3, 31, 0, 0)), true);
    assert.deepStrictEqual(
      matchesCron("@daily", zdt(2026, 3, 31, 0, 1)),
      false,
    );
  });

  test("同じ式とタイムゾーンでは Cron インスタンスが再利用されること", () => {
    clearCache();
    const t = zdt(2026, 3, 31, 9, 0);
    matchesCron("0 9 * * *", t);
    const sizeBefore = cacheSize();
    matchesCron("0 9 * * *", t);
    assert.deepStrictEqual(cacheSize(), sizeBefore);
    assert.deepStrictEqual(sizeBefore, 1);
    matchesCron("0 9 * * *", zdt(2026, 3, 31, 9, 0, "UTC"));
    assert.deepStrictEqual(cacheSize(), 2);
    clearCache();
    assert.deepStrictEqual(cacheSize(), 0);
  });
});

describe("parseCronExpression", () => {
  before(() => {
    clearCache();
  });

  test("ニックネームに余計な語が付いた式はエラーになること", () => {
    assert.throws(
      () => parseCronExpression("@daily junk"),
      errorWith(Error, "must have 5 fields"),
    );
    assert.throws(
      () => parseCronExpression("@2020-01-01T00:00:00"),
      errorWith(Error, "must have 5 fields"),
    );
  });

  test("ISO 日時の文字列はエラーになること", () => {
    assert.throws(
      () => parseCronExpression("2020-01-01T00:00:00"),
      errorWith(Error, "must have 5 fields"),
    );
  });

  test("永遠に一致しない式 (2 月 31 日) はエラーになること", () => {
    assert.throws(
      () => parseCronExpression("0 9 31 2 *"),
      errorWith(Error, "never matches"),
    );
  });

  test("正しい式でエラーにならないこと", () => {
    assert.doesNotThrow(() => parseCronExpression("0 9 * * 1-5"));
  });

  test("フィールド数が 5 でない場合はエラーになること", () => {
    assert.throws(
      () => parseCronExpression("* * *"),
      errorWith(Error, "must have 5 fields"),
    );
    assert.throws(() => parseCronExpression("* * * * * *"), errorWith(Error));
  });

  test("不正なステップ値でエラーになること", () => {
    assert.throws(() => parseCronExpression("*/0 * * * *"), errorWith(Error));
  });

  test("不正な値でエラーになること", () => {
    assert.throws(() => parseCronExpression("abc * * * *"), errorWith(Error));
    assert.throws(() => parseCronExpression("60 * * * *"), errorWith(Error));
  });

  test("逆順レンジでエラーになること", () => {
    assert.throws(() => parseCronExpression("5-1 * * * *"), errorWith(Error));
  });

  for (const bad of ["9,", "-5", "/15", "1-3-5", "1e1"]) {
    test(`不正なフィールド "${bad}" でエラーになること`, () => {
      assert.throws(
        () => parseCronExpression(`${bad} * * * *`),
        errorWith(Error),
      );
      assert.throws(
        () => parseCronExpression(`0 ${bad} * * *`),
        errorWith(Error),
      );
    });
  }
});
