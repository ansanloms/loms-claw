import { cli, define } from "gunshi";
import {
  buildForecastUrl,
  type ForecastParams,
  type OpenMeteoResponse,
  toResult,
} from "./openmeteo.ts";

/** 数値引数を検証付きでパースする。不正なら例外 (呼び出し側で exit 1)。 */
function parseNumber(
  name: string,
  value: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`--${name} が数値でない: ${value}`);
  }
  if (opts.integer === true && !Number.isInteger(n)) {
    throw new Error(`--${name} は整数で指定する: ${value}`);
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new Error(`--${name} が範囲外 (${opts.min} 以上): ${value}`);
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new Error(`--${name} が範囲外 (${opts.max} 以下): ${value}`);
  }
  return n;
}

/** forecast API を取得して JSON を返す。HTTP エラーは理由を添えて例外。 */
async function fetchForecast(url: string): Promise<OpenMeteoResponse> {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) {
    let reason = "";
    try {
      reason = (JSON.parse(text) as OpenMeteoResponse).reason ?? "";
    } catch {
      // JSON でないボディは理由なしとして扱う
    }
    throw new Error(
      `取得失敗 (HTTP ${res.status})${reason === "" ? "" : `: ${reason}`}`,
    );
  }
  try {
    return JSON.parse(text) as OpenMeteoResponse;
  } catch {
    throw new Error(
      "レスポンスが JSON として解釈できない (API 構造変化の可能性)。値を捏造せず停止する。",
    );
  }
}

const command = define({
  name: "fetch-openmeteo",
  description:
    "Open-Meteo から山頂標高指定の数値予報 (1 時間ごと) を取得し JSON で出力する",
  args: {
    lat: {
      type: "string",
      short: "a",
      description: "山頂の緯度 (十進度)",
    },
    lon: {
      type: "string",
      short: "o",
      description: "山頂の経度 (十進度)",
    },
    elevation: {
      type: "string",
      short: "e",
      description: "山頂標高 (m)。標高補正に使われる",
    },
    days: {
      type: "string",
      short: "d",
      default: "3",
      description: "予報日数 (既定 3、最大 7)",
    },
  },
  run: async (ctx) => {
    const { lat, lon, elevation, days } = ctx.values;

    if (lat === undefined || lon === undefined || elevation === undefined) {
      console.error(
        "usage: fetch-openmeteo --lat=<緯度> --lon=<経度> --elevation=<山頂標高 m> [--days=<1..7>]",
      );
      Deno.exit(1);
    }

    try {
      const params: ForecastParams = {
        lat: parseNumber("lat", lat, { min: -90, max: 90 }),
        lon: parseNumber("lon", lon, { min: -180, max: 180 }),
        elevation: parseNumber("elevation", elevation),
        days: parseNumber("days", days, { min: 1, max: 7, integer: true }),
      };
      const body = await fetchForecast(buildForecastUrl(params));
      const result = toResult(body, params);
      console.log(JSON.stringify(result, null, 2));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
