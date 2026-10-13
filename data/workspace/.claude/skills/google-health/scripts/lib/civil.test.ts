import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDailyRollupRange,
  checkDailyRollupRangeLimit,
  nextCivilDate,
  parseCivilDate,
} from "./civil.ts";

test("parseCivilDate: YYYY-MM-DD を分解する", () => {
  assert.deepEqual(parseCivilDate("2026-03-03"), {
    year: 2026,
    month: 3,
    day: 3,
  });
});

test("parseCivilDate: 不正形式はエラー", () => {
  assert.throws(() => parseCivilDate("2026/03/03"), /YYYY-MM-DD/);
});

test("parseCivilDate: 存在しない日付 (2026-02-31) はエラー", () => {
  assert.throws(() => parseCivilDate("2026-02-31"), /存在しない/);
});

test("parseCivilDate: 存在しない日付 (2026-04-31、4 月は 30 日まで) はエラー", () => {
  assert.throws(() => parseCivilDate("2026-04-31"), /存在しない/);
});

test("nextCivilDate: 月末をまたぐ", () => {
  assert.deepEqual(nextCivilDate({ year: 2026, month: 1, day: 31 }), {
    year: 2026,
    month: 2,
    day: 1,
  });
});

test("nextCivilDate: 年末をまたぐ", () => {
  assert.deepEqual(nextCivilDate({ year: 2026, month: 12, day: 31 }), {
    year: 2027,
    month: 1,
    day: 1,
  });
});

test("buildDailyRollupRange: --to は inclusive として翌日 00:00:00 を end にする", () => {
  const range = buildDailyRollupRange("2026-03-03", "2026-03-05");
  assert.deepEqual(range, {
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

test("checkDailyRollupRangeLimit: 対象 dataType で 14 日ちょうどは OK (境界)", () => {
  const range = buildDailyRollupRange("2026-01-01", "2026-01-14");
  checkDailyRollupRangeLimit("total-calories", range);
});

test("checkDailyRollupRangeLimit: 対象 dataType で 15 日は NG (境界)", () => {
  const range = buildDailyRollupRange("2026-01-01", "2026-01-15");
  assert.throws(
    () => checkDailyRollupRangeLimit("total-calories", range),
    /14/,
  );
});

test("checkDailyRollupRangeLimit: 対象外の dataType は日数に関係なく通す", () => {
  const range = buildDailyRollupRange("2026-01-01", "2026-02-01");
  checkDailyRollupRangeLimit("steps", range);
});

test("buildDailyRollupRange: from == to は許容する (inclusive の境界)", () => {
  const range = buildDailyRollupRange("2026-03-03", "2026-03-03");
  assert.deepEqual(range.start.date, { year: 2026, month: 3, day: 3 });
  assert.deepEqual(range.end.date, { year: 2026, month: 3, day: 4 });
});

test("buildDailyRollupRange: from が to より後だとエラー (どちらが逆かを書く)", () => {
  assert.throws(
    () => buildDailyRollupRange("2026-03-05", "2026-03-03"),
    /from=2026-03-05/,
  );
});
