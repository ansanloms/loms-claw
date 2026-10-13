import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFilter,
  DATA_TYPE_FILTER_FIELDS,
  validateRfc3339Range,
} from "./filter.ts";

test("buildFilter: interval 型 (RFC3339) は snake_case.interval.start_time で組み立てる", () => {
  const filter = buildFilter(
    "steps",
    "2026-04-20T00:00:00Z",
    "2026-04-21T00:00:00Z",
  );
  assert.deepEqual(
    filter,
    `steps.interval.start_time >= "2026-04-20T00:00:00Z" AND steps.interval.start_time < "2026-04-21T00:00:00Z"`,
  );
});

test("buildFilter: interval 型 (日付) は snake_case.interval.civil_start_time で組み立てる", () => {
  const filter = buildFilter("steps", "2026-03-03", "2026-03-04");
  assert.deepEqual(
    filter,
    `steps.interval.civil_start_time >= "2026-03-03" AND steps.interval.civil_start_time < "2026-03-04"`,
  );
});

test("buildFilter: sleep は終了基準 (civil_end_time / end_time) で組み立てる", () => {
  const dateFilter = buildFilter("sleep", "2026-03-03", "2026-03-04");
  assert.deepEqual(
    dateFilter,
    `sleep.interval.civil_end_time >= "2026-03-03" AND sleep.interval.civil_end_time < "2026-03-04"`,
  );

  const rfc3339Filter = buildFilter(
    "sleep",
    "2026-03-03T00:00:00Z",
    "2026-03-04T00:00:00Z",
  );
  assert.deepEqual(
    rfc3339Filter,
    `sleep.interval.end_time >= "2026-03-03T00:00:00Z" AND sleep.interval.end_time < "2026-03-04T00:00:00Z"`,
  );
});

test("buildFilter: exercise は日付 (civil_start_time) のみ通り、RFC3339 はエラー", () => {
  const filter = buildFilter("exercise", "2026-03-03", "2026-03-04");
  assert.deepEqual(
    filter,
    `exercise.interval.civil_start_time >= "2026-03-03" AND exercise.interval.civil_start_time < "2026-03-04"`,
  );

  assert.throws(
    () =>
      buildFilter("exercise", "2026-03-03T00:00:00Z", "2026-03-04T00:00:00Z"),
    /日付/,
  );
});

test("buildFilter: nutrition-log は日付 (civil_start_time) のみ通り、RFC3339 はエラー", () => {
  const filter = buildFilter("nutrition-log", "2026-03-03", "2026-03-04");
  assert.deepEqual(
    filter,
    `nutrition_log.interval.civil_start_time >= "2026-03-03" AND nutrition_log.interval.civil_start_time < "2026-03-04"`,
  );

  assert.throws(
    () =>
      buildFilter(
        "nutrition-log",
        "2026-03-03T00:00:00Z",
        "2026-03-04T00:00:00Z",
      ),
    /日付/,
  );
});

test("buildFilter: sample 型は sample_time.physical_time (RFC3339) で組み立て、日付形式はエラーになる", () => {
  for (const { dataType, field } of [
    { dataType: "heart-rate", field: "heart_rate" },
    { dataType: "weight", field: "weight" },
    { dataType: "body-fat", field: "body_fat" },
  ]) {
    const filter = buildFilter(
      dataType,
      "2026-04-20T00:00:00Z",
      "2026-04-21T00:00:00Z",
    );
    assert.deepEqual(
      filter,
      `${field}.sample_time.physical_time >= "2026-04-20T00:00:00Z" AND ${field}.sample_time.physical_time < "2026-04-21T00:00:00Z"`,
    );

    assert.throws(
      () => buildFilter(dataType, "2026-04-20", "2026-04-21"),
      /RFC3339/,
    );
  }
});

test("buildFilter: from/to の形式が食い違うとエラー", () => {
  assert.throws(
    () => buildFilter("steps", "2026-04-20", "2026-04-21T00:00:00Z"),
    /同じ形式/,
  );
});

test("buildFilter: 不正な形式はエラー", () => {
  assert.throws(
    () => buildFilter("steps", "not-a-date", "2026-04-21"),
    /YYYY-MM-DD/,
  );
});

test("buildFilter: 存在しない日付 (2026-02-31) はエラー", () => {
  assert.throws(
    () => buildFilter("steps", "2026-02-31", "2026-03-01"),
    /存在しない/,
  );
});

test("buildFilter: 形式は一致していても実在しない日時 (13 月) はエラー (RFC3339)", () => {
  assert.throws(
    () =>
      buildFilter("heart-rate", "2026-13-01T00:00:00Z", "2026-04-21T00:00:00Z"),
    /実在する日時ではない/,
  );
  assert.throws(
    () =>
      buildFilter("heart-rate", "2026-04-20T00:00:00Z", "2026-13-01T00:00:00Z"),
    /実在する日時ではない/,
  );
});

test("buildFilter: from >= to (日付) はエラー (exclusive、どちらが逆かを書く)", () => {
  assert.throws(
    () => buildFilter("steps", "2026-04-21", "2026-04-20"),
    /from=2026-04-21/,
  );
});

test("buildFilter: from == to (日付) もエラー (exclusive なので等しいのは不可)", () => {
  assert.throws(
    () => buildFilter("steps", "2026-04-20", "2026-04-20"),
    /exclusive/,
  );
});

test("buildFilter: from >= to (RFC3339) はエラー", () => {
  assert.throws(
    () =>
      buildFilter("heart-rate", "2026-04-20T10:00:00Z", "2026-04-20T09:00:00Z"),
    /exclusive/,
  );
});

test("DATA_TYPE_FILTER_FIELDS: exercise・sleep の pageSize は 25、それ以外は 10000", () => {
  for (const dataType of [
    "steps",
    "active-minutes",
    "active-zone-minutes",
    "distance",
    "heart-rate",
    "weight",
    "body-fat",
    "nutrition-log",
  ]) {
    assert.deepEqual(DATA_TYPE_FILTER_FIELDS[dataType].pageSize, 10000);
  }
  for (const dataType of ["exercise", "sleep"]) {
    assert.deepEqual(DATA_TYPE_FILTER_FIELDS[dataType].pageSize, 25);
  }
});

test("buildFilter: 未対応の dataType はエラー", () => {
  assert.throws(
    () => buildFilter("unknown-type", "2026-04-20", "2026-04-21"),
    /未対応/,
  );
});

test("validateRfc3339Range: 不正な文字列はエラー", () => {
  assert.throws(
    () => validateRfc3339Range("not-a-date", "2026-04-21T00:00:00Z"),
    /RFC3339/,
  );
});

test("validateRfc3339Range: 日付形式 (YYYY-MM-DD) は RFC3339 でないのでエラー", () => {
  assert.throws(
    () => validateRfc3339Range("2026-04-20", "2026-04-21"),
    /RFC3339/,
  );
});

test("validateRfc3339Range: from >= to はエラー", () => {
  assert.throws(
    () => validateRfc3339Range("2026-04-21T00:00:00Z", "2026-04-20T00:00:00Z"),
    /exclusive/,
  );
  assert.throws(
    () => validateRfc3339Range("2026-04-20T00:00:00Z", "2026-04-20T00:00:00Z"),
    /exclusive/,
  );
});

test("validateRfc3339Range: from/to とも RFC3339 で from < to なら通る", () => {
  validateRfc3339Range("2026-04-20T00:00:00Z", "2026-04-21T00:00:00Z");
});

test("validateRfc3339Range: 形式は一致していても実在しない日時 (13 月) はエラー", () => {
  assert.throws(
    () => validateRfc3339Range("2026-13-01T00:00:00Z", "2026-04-21T00:00:00Z"),
    /実在する日時ではない/,
  );
  assert.throws(
    () => validateRfc3339Range("2026-04-20T00:00:00Z", "2026-13-01T00:00:00Z"),
    /実在する日時ではない/,
  );
});
