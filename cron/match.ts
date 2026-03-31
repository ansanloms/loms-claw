/**
 * cron 式のパースとマッチング。
 *
 * 標準 5 フィールド cron（分 時 日 月 曜日）をサポートする。
 * 各フィールドは `*`, `N`, `N-M`, `N/step`, `N-M/step`, `N,M,...` の組み合わせ。
 * 曜日は 0-7（0 と 7 はいずれも日曜日）。
 *
 * @module
 */

/**
 * パース済み cron フィールド。各要素はそのフィールドでマッチする値の Set。
 */
interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
}

/**
 * パース結果のキャッシュ。同じ式を毎分評価するのでキャッシュが有効。
 */
const cache = new Map<string, CronFields>();

/**
 * フィールド定義。名前と有効範囲。
 */
const FIELD_DEFS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "dayOfWeek", min: 0, max: 7 },
] as const;

/**
 * 単一のサブ式（カンマ区切りの 1 要素）をパースして値の配列を返す。
 *
 * サポートする構文:
 * - `*` — 全値
 * - `N` — 単一値
 * - `N-M` — 範囲
 * - `X/step` — X は `*` または `N` または `N-M`
 */
function parseSubExpr(sub: string, min: number, max: number): number[] {
  const values: number[] = [];

  let range: string;
  let step = 1;

  // step 分離
  const slashIdx = sub.indexOf("/");
  if (slashIdx !== -1) {
    range = sub.slice(0, slashIdx);
    step = Number(sub.slice(slashIdx + 1));
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid step: ${sub}`);
    }
  } else {
    range = sub;
  }

  let start: number;
  let end: number;

  if (range === "*") {
    start = min;
    end = max;
  } else if (range.includes("-")) {
    const [a, b] = range.split("-");
    start = Number(a);
    end = Number(b);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`invalid range: ${sub}`);
    }
    if (start > end) {
      throw new Error(`invalid range: ${sub} (start must be <= end)`);
    }
  } else {
    const n = Number(range);
    if (!Number.isInteger(n)) {
      throw new Error(`invalid value: ${sub}`);
    }
    if (slashIdx !== -1) {
      // N/step → N から max まで step 刻み
      start = n;
      end = max;
    } else {
      // 単一値
      return [n];
    }
  }

  for (let i = start; i <= end; i += step) {
    values.push(i);
  }

  return values;
}

/**
 * 単一フィールド文字列をパースして、マッチする値の Set を返す。
 */
function parseField(field: string, min: number, max: number): Set<number> {
  const parts = field.split(",");
  const result = new Set<number>();

  for (const part of parts) {
    const values = parseSubExpr(part.trim(), min, max);
    for (const v of values) {
      if (v < min || v > max) {
        throw new Error(
          `value ${v} out of range [${min}-${max}] in field: ${field}`,
        );
      }
      // 曜日の 7 を 0 に正規化（両方とも日曜日）
      result.add(max === 7 && v === 7 ? 0 : v);
    }
  }

  return result;
}

/**
 * cron 式をパースする。結果はキャッシュされる。
 *
 * @throws 構文エラー時。
 */
export function parseCronExpression(expression: string): CronFields {
  const cached = cache.get(expression);
  if (cached) {
    return cached;
  }

  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `cron expression must have 5 fields, got ${parts.length}: "${expression}"`,
    );
  }

  const fields: CronFields = {
    minute: parseField(parts[0], FIELD_DEFS[0].min, FIELD_DEFS[0].max),
    hour: parseField(parts[1], FIELD_DEFS[1].min, FIELD_DEFS[1].max),
    dayOfMonth: parseField(parts[2], FIELD_DEFS[2].min, FIELD_DEFS[2].max),
    month: parseField(parts[3], FIELD_DEFS[3].min, FIELD_DEFS[3].max),
    dayOfWeek: parseField(parts[4], FIELD_DEFS[4].min, FIELD_DEFS[4].max),
  };

  cache.set(expression, fields);
  return fields;
}

/**
 * 指定された日時が cron 式にマッチするかを判定する。
 *
 * Temporal API を使用し、システムのタイムゾーン（TZ 環境変数）で評価される。
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
  const fields = parseCronExpression(expression);
  const zdt = now ?? Temporal.Now.zonedDateTimeISO();

  return (
    fields.minute.has(zdt.minute) &&
    fields.hour.has(zdt.hour) &&
    fields.dayOfMonth.has(zdt.day) &&
    fields.month.has(zdt.month) &&
    fields.dayOfWeek.has(zdt.dayOfWeek % 7) // Temporal: 1=月..7=日 → 0=日,1=月..6=土
  );
}

/**
 * パースキャッシュをクリアする（テスト用）。
 */
export function clearCache(): void {
  cache.clear();
}
