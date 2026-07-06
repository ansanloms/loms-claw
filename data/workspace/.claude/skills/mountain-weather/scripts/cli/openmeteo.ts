/**
 * Open-Meteo forecast API のリクエスト構築・レスポンス検証・整形。
 * ネットワーク非依存 (テスト可能)。取得は cli/fetch-openmeteo.ts が行う。
 */

const BASE = "https://api.open-meteo.com/v1/forecast";

/** 取得する 1 時間ごとの変数 (固定)。weather_code は WMO コードの数値のまま扱う。 */
export const HOURLY_VARS = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "wind_gusts_10m",
  "precipitation",
  "precipitation_probability",
  "freezing_level_height",
  "weather_code",
] as const;

export type HourlyVar = (typeof HOURLY_VARS)[number];

export type ForecastParams = {
  lat: number;
  lon: number;
  elevation: number;
  days: number;
};

/** Open-Meteo のレスポンス (必要な部分のみ)。 */
export type OpenMeteoResponse = {
  error?: boolean;
  reason?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
  timezone?: string;
  hourly_units?: Record<string, string>;
  hourly?: Record<string, unknown>;
};

/** 時刻 1 点分のレコード。取得変数は数値または null (欠測はそのまま残す)。 */
export type HourlyRecord =
  & { time: string }
  & {
    [K in HourlyVar]: number | null;
  };

export type Result = {
  source: string;
  license: string;
  latitude: number;
  longitude: number;
  /** 標高補正に使われた標高 (指定値と一致することを検証済み)。 */
  elevation: number;
  timezone: string;
  /** 変数名 → 単位。weather_code は WMO コード (数値)。 */
  units: Record<HourlyVar, string>;
  hourly: HourlyRecord[];
};

/** forecast API の URL を組み立てる。timezone・風速単位は固定。 */
export function buildForecastUrl(p: ForecastParams): string {
  const query = new URLSearchParams({
    latitude: String(p.lat),
    longitude: String(p.lon),
    elevation: String(p.elevation),
    hourly: HOURLY_VARS.join(","),
    timezone: "Asia/Tokyo",
    wind_speed_unit: "ms",
    forecast_days: String(p.days),
  });
  return `${BASE}?${query}`;
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

/**
 * レスポンスを検証して整形する。次のいずれかで捏造せず例外を投げる。
 * - `error: true` (API がエラーを返した)
 * - `elevation` が指定値と不一致 (標高補正が指定標高で行われていない)
 * - hourly の構造欠落・時刻列との長さ不一致 (API 構造変化の可能性)
 */
export function toResult(
  body: OpenMeteoResponse,
  requested: ForecastParams,
): Result {
  if (body.error === true) {
    throw new Error(
      `Open-Meteo がエラーを返した: ${body.reason ?? "(理由なし)"}`,
    );
  }
  if (body.elevation !== requested.elevation) {
    throw new Error(
      `レスポンスの elevation (${body.elevation}) が指定値 (${requested.elevation}) と一致しない。` +
        "標高補正が指定標高で行われていない可能性。値を捏造せず停止する。",
    );
  }

  const hourly = body.hourly;
  const time = hourly?.time;
  if (hourly === undefined || !Array.isArray(time)) {
    throw new Error(
      "レスポンスに hourly.time が無い (API 構造変化の可能性)。値を捏造せず停止する。",
    );
  }

  const series = {} as Record<HourlyVar, (number | null)[]>;
  for (const name of HOURLY_VARS) {
    const values = hourly[name];
    if (!Array.isArray(values) || values.length !== time.length) {
      throw new Error(
        `レスポンスの hourly.${name} が欠落しているか時刻列と長さが一致しない ` +
          "(API 構造変化の可能性)。値を捏造せず停止する。",
      );
    }
    if (!values.every(isNumberOrNull)) {
      throw new Error(
        `hourly.${name} に数値・null 以外の値が混じっている (API 構造変化の可能性)。値を捏造せず停止する。`,
      );
    }
    series[name] = values;
  }

  const units = {} as Record<HourlyVar, string>;
  for (const name of HOURLY_VARS) {
    units[name] = body.hourly_units?.[name] ?? "";
  }

  const records = time.map((t, i): HourlyRecord => {
    const rec = { time: String(t) } as HourlyRecord;
    for (const name of HOURLY_VARS) {
      rec[name] = series[name][i];
    }
    return rec;
  });

  return {
    source: "Open-Meteo (https://open-meteo.com/)",
    license: "CC BY 4.0",
    latitude: body.latitude ?? requested.lat,
    longitude: body.longitude ?? requested.lon,
    elevation: body.elevation,
    timezone: body.timezone ?? "Asia/Tokyo",
    units,
    hourly: records,
  };
}
