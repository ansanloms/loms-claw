import { assertEquals, assertThrows } from "@std/assert";
import {
  buildDailyRollupRange,
  checkDailyRollupRangeLimit,
  nextCivilDate,
  parseCivilDate,
} from "./civil.ts";

Deno.test("parseCivilDate: YYYY-MM-DD を分解する", () => {
  assertEquals(parseCivilDate("2026-03-03"), { year: 2026, month: 3, day: 3 });
});

Deno.test("parseCivilDate: 不正形式はエラー", () => {
  assertThrows(() => parseCivilDate("2026/03/03"), Error, "YYYY-MM-DD");
});

Deno.test("parseCivilDate: 存在しない日付 (2026-02-31) はエラー", () => {
  assertThrows(() => parseCivilDate("2026-02-31"), Error, "存在しない");
});

Deno.test("parseCivilDate: 存在しない日付 (2026-04-31、4 月は 30 日まで) はエラー", () => {
  assertThrows(() => parseCivilDate("2026-04-31"), Error, "存在しない");
});

Deno.test("nextCivilDate: 月末をまたぐ", () => {
  assertEquals(nextCivilDate({ year: 2026, month: 1, day: 31 }), {
    year: 2026,
    month: 2,
    day: 1,
  });
});

Deno.test("nextCivilDate: 年末をまたぐ", () => {
  assertEquals(nextCivilDate({ year: 2026, month: 12, day: 31 }), {
    year: 2027,
    month: 1,
    day: 1,
  });
});

Deno.test("buildDailyRollupRange: --to は inclusive として翌日 00:00:00 を end にする", () => {
  const range = buildDailyRollupRange("2026-03-03", "2026-03-05");
  assertEquals(range, {
    start: {
      date: { year: 2026, month: 3, day: 3 },
      time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
    },
    end: {
      date: { year: 2026, month: 3, day: 6 },
      time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 },
    },
  });
});

Deno.test("checkDailyRollupRangeLimit: 対象 dataType で 14 日ちょうどは OK (境界)", () => {
  const range = buildDailyRollupRange("2026-01-01", "2026-01-14");
  checkDailyRollupRangeLimit("total-calories", range);
});

Deno.test("checkDailyRollupRangeLimit: 対象 dataType で 15 日は NG (境界)", () => {
  const range = buildDailyRollupRange("2026-01-01", "2026-01-15");
  assertThrows(
    () => checkDailyRollupRangeLimit("total-calories", range),
    Error,
    "14",
  );
});

Deno.test("checkDailyRollupRangeLimit: 対象外の dataType は日数に関係なく通す", () => {
  const range = buildDailyRollupRange("2026-01-01", "2026-02-01");
  checkDailyRollupRangeLimit("steps", range);
});

Deno.test("buildDailyRollupRange: from == to は許容する (inclusive の境界)", () => {
  const range = buildDailyRollupRange("2026-03-03", "2026-03-03");
  assertEquals(range.start.date, { year: 2026, month: 3, day: 3 });
  assertEquals(range.end.date, { year: 2026, month: 3, day: 4 });
});

Deno.test("buildDailyRollupRange: from が to より後だとエラー (どちらが逆かを書く)", () => {
  assertThrows(
    () => buildDailyRollupRange("2026-03-05", "2026-03-03"),
    Error,
    "from=2026-03-05",
  );
});
