import { assertEquals, assertThrows } from "@std/assert";
import { buildFilter, DATA_TYPE_FILTER_FIELDS } from "./filter.ts";

Deno.test("buildFilter: interval 型 (RFC3339) は snake_case.interval.start_time で組み立てる", () => {
  const filter = buildFilter(
    "steps",
    "2026-04-20T00:00:00Z",
    "2026-04-21T00:00:00Z",
  );
  assertEquals(
    filter,
    `steps.interval.start_time >= "2026-04-20T00:00:00Z" AND steps.interval.start_time < "2026-04-21T00:00:00Z"`,
  );
});

Deno.test("buildFilter: interval 型 (日付) は snake_case.interval.civil_start_time で組み立てる", () => {
  const filter = buildFilter("steps", "2026-03-03", "2026-03-04");
  assertEquals(
    filter,
    `steps.interval.civil_start_time >= "2026-03-03" AND steps.interval.civil_start_time < "2026-03-04"`,
  );
});

Deno.test("buildFilter: sleep は終了基準 (civil_end_time / end_time) で組み立てる", () => {
  const dateFilter = buildFilter("sleep", "2026-03-03", "2026-03-04");
  assertEquals(
    dateFilter,
    `sleep.interval.civil_end_time >= "2026-03-03" AND sleep.interval.civil_end_time < "2026-03-04"`,
  );

  const rfc3339Filter = buildFilter(
    "sleep",
    "2026-03-03T00:00:00Z",
    "2026-03-04T00:00:00Z",
  );
  assertEquals(
    rfc3339Filter,
    `sleep.interval.end_time >= "2026-03-03T00:00:00Z" AND sleep.interval.end_time < "2026-03-04T00:00:00Z"`,
  );
});

Deno.test("buildFilter: exercise は日付 (civil_start_time) のみ通り、RFC3339 はエラー", () => {
  const filter = buildFilter("exercise", "2026-03-03", "2026-03-04");
  assertEquals(
    filter,
    `exercise.interval.civil_start_time >= "2026-03-03" AND exercise.interval.civil_start_time < "2026-03-04"`,
  );

  assertThrows(
    () =>
      buildFilter(
        "exercise",
        "2026-03-03T00:00:00Z",
        "2026-03-04T00:00:00Z",
      ),
    Error,
    "日付",
  );
});

Deno.test("buildFilter: sample 型は sample_time.physical_time (RFC3339) で組み立て、日付形式はエラーになる", () => {
  for (
    const { dataType, field } of [
      { dataType: "heart-rate", field: "heart_rate" },
      { dataType: "weight", field: "weight" },
      { dataType: "body-fat", field: "body_fat" },
    ]
  ) {
    const filter = buildFilter(
      dataType,
      "2026-04-20T00:00:00Z",
      "2026-04-21T00:00:00Z",
    );
    assertEquals(
      filter,
      `${field}.sample_time.physical_time >= "2026-04-20T00:00:00Z" AND ${field}.sample_time.physical_time < "2026-04-21T00:00:00Z"`,
    );

    assertThrows(
      () => buildFilter(dataType, "2026-04-20", "2026-04-21"),
      Error,
      "RFC3339",
    );
  }
});

Deno.test("buildFilter: from/to の形式が食い違うとエラー", () => {
  assertThrows(
    () => buildFilter("steps", "2026-04-20", "2026-04-21T00:00:00Z"),
    Error,
    "同じ形式",
  );
});

Deno.test("buildFilter: 不正な形式はエラー", () => {
  assertThrows(
    () => buildFilter("steps", "not-a-date", "2026-04-21"),
    Error,
    "YYYY-MM-DD",
  );
});

Deno.test("buildFilter: 存在しない日付 (2026-02-31) はエラー", () => {
  assertThrows(
    () => buildFilter("steps", "2026-02-31", "2026-03-01"),
    Error,
    "存在しない",
  );
});

Deno.test("buildFilter: from >= to (日付) はエラー (exclusive、どちらが逆かを書く)", () => {
  assertThrows(
    () => buildFilter("steps", "2026-04-21", "2026-04-20"),
    Error,
    "from=2026-04-21",
  );
});

Deno.test("buildFilter: from == to (日付) もエラー (exclusive なので等しいのは不可)", () => {
  assertThrows(
    () => buildFilter("steps", "2026-04-20", "2026-04-20"),
    Error,
    "exclusive",
  );
});

Deno.test("buildFilter: from >= to (RFC3339) はエラー", () => {
  assertThrows(
    () =>
      buildFilter(
        "heart-rate",
        "2026-04-20T10:00:00Z",
        "2026-04-20T09:00:00Z",
      ),
    Error,
    "exclusive",
  );
});

Deno.test("DATA_TYPE_FILTER_FIELDS: exercise・sleep の pageSize は 25、それ以外は 10000", () => {
  for (
    const dataType of [
      "steps",
      "active-minutes",
      "active-zone-minutes",
      "distance",
      "heart-rate",
      "weight",
      "body-fat",
    ]
  ) {
    assertEquals(DATA_TYPE_FILTER_FIELDS[dataType].pageSize, 10000);
  }
  for (const dataType of ["exercise", "sleep"]) {
    assertEquals(DATA_TYPE_FILTER_FIELDS[dataType].pageSize, 25);
  }
});

Deno.test("buildFilter: 未対応の dataType はエラー", () => {
  assertThrows(
    () => buildFilter("unknown-type", "2026-04-20", "2026-04-21"),
    Error,
    "未対応",
  );
});
