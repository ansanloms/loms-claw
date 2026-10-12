import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildForecastUrl,
  HOURLY_VARS,
  type OpenMeteoResponse,
  toResult,
} from "./openmeteo.ts";

const PARAMS = { lat: 35.3606, lon: 138.7274, elevation: 3776, days: 3 };

/** 正常系レスポンスの雛形。時刻 2 点、欠測 (null) を 1 つ含む。 */
function validBody(): OpenMeteoResponse {
  const hourly: Record<string, unknown> = {
    time: ["2026-07-06T00:00", "2026-07-06T01:00"],
  };
  for (const name of HOURLY_VARS) {
    hourly[name] = [1, 2];
  }
  hourly.precipitation_probability = [null, 40]; // 欠測はそのまま残る
  const hourly_units: Record<string, string> = { time: "iso8601" };
  for (const name of HOURLY_VARS) {
    hourly_units[name] = "unit";
  }
  return {
    latitude: 35.375,
    longitude: 138.75,
    elevation: 3776,
    timezone: "Asia/Tokyo",
    hourly_units,
    hourly,
  };
}

test("buildForecastUrl: 固定パラメータと指定値が全て入る", () => {
  const url = new URL(buildForecastUrl(PARAMS));
  const q = url.searchParams;
  assert.deepEqual(q.get("latitude"), "35.3606");
  assert.deepEqual(q.get("longitude"), "138.7274");
  assert.deepEqual(q.get("elevation"), "3776");
  assert.deepEqual(q.get("hourly"), HOURLY_VARS.join(","));
  assert.deepEqual(q.get("timezone"), "Asia/Tokyo");
  assert.deepEqual(q.get("wind_speed_unit"), "ms");
  assert.deepEqual(q.get("forecast_days"), "3");
});

test("toResult: 時刻ごとのレコードに整形し、単位と null を保持する", () => {
  const r = toResult(validBody(), PARAMS);
  assert.deepEqual(r.elevation, 3776);
  assert.deepEqual(r.hourly.length, 2);
  assert.deepEqual(r.hourly[0].time, "2026-07-06T00:00");
  assert.deepEqual(r.hourly[0].temperature_2m, 1);
  assert.deepEqual(r.hourly[0].precipitation_probability, null);
  assert.deepEqual(r.hourly[1].precipitation_probability, 40);
  assert.deepEqual(r.units.temperature_2m, "unit");
  assert.deepEqual(r.license, "CC BY 4.0");
});

test("toResult: elevation 不一致は例外 (標高補正の検証)", () => {
  const body = validBody();
  body.elevation = 3720; // API が DEM 標高等に置き換えた想定
  assert.throws(() => toResult(body, PARAMS), /elevation/);
});

test("toResult: error レスポンスは reason 付きで例外", () => {
  const body: OpenMeteoResponse = { error: true, reason: "Invalid latitude" };
  assert.throws(() => toResult(body, PARAMS), /Invalid latitude/);
});

test("toResult: 変数の欠落は例外 (API 構造変化)", () => {
  const body = validBody();
  delete (body.hourly as Record<string, unknown>).freezing_level_height;
  assert.throws(() => toResult(body, PARAMS), /freezing_level_height/);
});

test("toResult: 時刻列と長さ不一致は例外", () => {
  const body = validBody();
  (body.hourly as Record<string, unknown>).temperature_2m = [1];
  assert.throws(() => toResult(body, PARAMS), /temperature_2m/);
});
