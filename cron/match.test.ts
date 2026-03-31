import { assertEquals, assertThrows } from "@std/assert";
import { clearCache, matchesCron, parseCronExpression } from "./match.ts";

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

Deno.test("matchesCron", async (t) => {
  clearCache();

  await t.step("'* * * * *' は全ての日時にマッチすること", () => {
    assertEquals(matchesCron("* * * * *", zdt(2026, 3, 31, 12, 30)), true);
    assertEquals(matchesCron("* * * * *", zdt(2026, 1, 1, 0, 0)), true);
  });

  await t.step("固定の分・時にマッチすること", () => {
    assertEquals(matchesCron("0 9 * * *", zdt(2026, 3, 31, 9, 0)), true);
    assertEquals(matchesCron("0 9 * * *", zdt(2026, 3, 31, 9, 1)), false);
    assertEquals(matchesCron("0 9 * * *", zdt(2026, 3, 31, 10, 0)), false);
  });

  await t.step("ステップ式 */N が正しくマッチすること", () => {
    assertEquals(matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 0)), true);
    assertEquals(matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 15)), true);
    assertEquals(matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 30)), true);
    assertEquals(matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 45)), true);
    assertEquals(matchesCron("*/15 * * * *", zdt(2026, 1, 1, 0, 7)), false);
  });

  await t.step("範囲式 N-M が正しくマッチすること", () => {
    // 月-金（1-5）
    // 2026-03-31 は火曜日（dayOfWeek === 2）
    assertEquals(matchesCron("0 9 * * 1-5", zdt(2026, 3, 31, 9, 0)), true);
    // 2026-03-29 は日曜日（dayOfWeek === 7 → %7 === 0）
    assertEquals(matchesCron("0 9 * * 1-5", zdt(2026, 3, 29, 9, 0)), false);
  });

  await t.step("リスト式 N,M,L が正しくマッチすること", () => {
    assertEquals(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 5)),
      true,
    );
    assertEquals(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 10)),
      true,
    );
    assertEquals(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 15)),
      true,
    );
    assertEquals(
      matchesCron("5,10,15 * * * *", zdt(2026, 1, 1, 0, 6)),
      false,
    );
  });

  await t.step("曜日 0 と 7 が両方とも日曜日として扱われること", () => {
    // 2026-03-29 は日曜日
    assertEquals(matchesCron("0 9 * * 0", zdt(2026, 3, 29, 9, 0)), true);
    assertEquals(matchesCron("0 9 * * 7", zdt(2026, 3, 29, 9, 0)), true);
  });

  await t.step("日・月の固定値がマッチすること", () => {
    assertEquals(matchesCron("0 9 15 6 *", zdt(2026, 6, 15, 9, 0)), true);
    assertEquals(matchesCron("0 9 15 6 *", zdt(2026, 6, 14, 9, 0)), false);
    assertEquals(matchesCron("0 9 15 6 *", zdt(2026, 7, 15, 9, 0)), false);
  });

  await t.step("毎月1日 00:00 がマッチすること", () => {
    assertEquals(matchesCron("0 0 1 * *", zdt(2026, 4, 1, 0, 0)), true);
    assertEquals(matchesCron("0 0 1 * *", zdt(2026, 4, 2, 0, 0)), false);
  });

  await t.step("年末の境界値がマッチすること", () => {
    assertEquals(
      matchesCron("59 23 31 12 *", zdt(2026, 12, 31, 23, 59)),
      true,
    );
  });

  await t.step("範囲 + ステップが正しくマッチすること", () => {
    // 1-5/2 → 1, 3, 5
    assertEquals(
      matchesCron("0 9 * * 1-5/2", zdt(2026, 3, 30, 9, 0)),
      true,
    ); // 月曜=1
    assertEquals(
      matchesCron("0 9 * * 1-5/2", zdt(2026, 3, 31, 9, 0)),
      false,
    ); // 火曜=2
    assertEquals(
      matchesCron("0 9 * * 1-5/2", zdt(2026, 4, 1, 9, 0)),
      true,
    ); // 水曜=3
  });

  await t.step("全フィールド組み合わせがマッチすること", () => {
    // 毎月15日 09:30 の月曜日
    // 2026-06-15 は月曜日
    assertEquals(
      matchesCron("30 9 15 6 1", zdt(2026, 6, 15, 9, 30)),
      true,
    );
    assertEquals(
      matchesCron("30 9 15 6 1", zdt(2026, 6, 15, 9, 31)),
      false,
    );
  });

  await t.step("異なるタイムゾーンで正しく評価されること", () => {
    // UTC 09:00 は Asia/Tokyo では 18:00
    const utcNine = zdt(2026, 3, 31, 9, 0, "UTC");
    const jstEighteen = zdt(2026, 3, 31, 18, 0, "Asia/Tokyo");

    assertEquals(matchesCron("0 9 * * *", utcNine), true);
    assertEquals(matchesCron("0 18 * * *", jstEighteen), true);
    assertEquals(matchesCron("0 9 * * *", jstEighteen), false);
  });
});

Deno.test("parseCronExpression", async (t) => {
  clearCache();

  await t.step("フィールド数が 5 でない場合はエラーになること", () => {
    assertThrows(
      () => parseCronExpression("* * *"),
      Error,
      "must have 5 fields",
    );
  });

  await t.step("不正なステップ値でエラーになること", () => {
    assertThrows(
      () => parseCronExpression("*/0 * * * *"),
      Error,
      "invalid step",
    );
  });

  await t.step("不正な値でエラーになること", () => {
    assertThrows(
      () => parseCronExpression("abc * * * *"),
      Error,
      "invalid value",
    );
  });

  await t.step("パース結果がキャッシュされること", () => {
    clearCache();
    const a = parseCronExpression("0 9 * * *");
    const b = parseCronExpression("0 9 * * *");
    assertEquals(a, b);
  });
});
