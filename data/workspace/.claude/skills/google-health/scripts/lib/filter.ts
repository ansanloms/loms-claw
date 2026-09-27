/**
 * datapoints サブコマンドの filter (AIP-160 形式) 組み立て。
 * dataType → { field, kind } の表として持ち、実 API で通らなかった場合はここだけ直す。
 */
import { parseCivilDate } from "./civil.ts";

export type FilterFieldEntry =
  | {
    kind: "interval";
    /** filter 文字列で使う snake_case のフィールド名。 */
    field: string;
    /** 日付形式 (YYYY-MM-DD) のとき interval.<member> に使うメンバー名。undefined なら日付形式は非対応。 */
    dateMember?: string;
    /** RFC3339 のとき interval.<member> に使うメンバー名。undefined なら RFC3339 は非対応。 */
    rfc3339Member?: string;
    /** dataPoints.list に付ける pageSize (公式リファレンス実測値)。 */
    pageSize: number;
  }
  | {
    kind: "sample";
    /** filter 文字列で使う snake_case のフィールド名。 */
    field: string;
    /** dataPoints.list に付ける pageSize (公式リファレンス実測値)。 */
    pageSize: number;
  };

/**
 * 実 API (2026-09-26、Pixel Watch 4 で実測) で通った filter メンバーの表。
 * - steps・active-minutes・distance は日付・RFC3339 の両方が通る。active-zone-minutes は未実測で同じ扱いにしてある。
 * - exercise は日付 (civil_start_time) のみ通り、RFC3339 (start_time) は 400 (`Member 'exercise.interval.start_time' is not supported for filtering`)。
 * - sleep は開始基準 (civil_start_time・start_time) がどちらも 400 (`INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER`) で、終了基準 (civil_end_time・end_time) のみ通る。
 *   つまり --from/--to は起床時刻 (interval の終端) で切られる。
 * - heart-rate・weight・body-fat (いずれも sample 型) は sample_time.physical_time (RFC3339 のみ) が通る
 *   (weight・body-fat は 2026-09-27 実測、Health Planet アプリが Health Connect に書いたデータ)。
 * - nutrition-log は exercise と同じ傾向で、開始基準の日付 (civil_start_time) のみ通る。
 *   start_time・end_time・civil_end_time はいずれも 400 (INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER、2026-09-27 実測)。
 *   pageSize は 25 (exercise・sleep と同じ Session 型) ではなく 10000 が通った (2026-09-27 実測)。
 *
 * pageSize は公式リファレンス (https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/list)
 * の既定は 1440・最大は 10000 (exercise・sleep は既定・最大とも 25)。ただし heart-rate は
 * pageSize 未指定で 50 件/ページだった (2026-09-26 実測)。ここでは全型で上限値を明示指定し、
 * 実際の既定値に関わらずリクエスト数の膨張を避ける。
 */
export const DATA_TYPE_FILTER_FIELDS: Readonly<
  Record<string, FilterFieldEntry>
> = {
  "steps": {
    kind: "interval",
    field: "steps",
    dateMember: "civil_start_time",
    rfc3339Member: "start_time",
    pageSize: 10000,
  },
  "active-minutes": {
    kind: "interval",
    field: "active_minutes",
    dateMember: "civil_start_time",
    rfc3339Member: "start_time",
    pageSize: 10000,
  },
  "active-zone-minutes": {
    kind: "interval",
    field: "active_zone_minutes",
    dateMember: "civil_start_time",
    rfc3339Member: "start_time",
    pageSize: 10000,
  },
  "distance": {
    kind: "interval",
    field: "distance",
    dateMember: "civil_start_time",
    rfc3339Member: "start_time",
    pageSize: 10000,
  },
  "exercise": {
    kind: "interval",
    field: "exercise",
    dateMember: "civil_start_time",
    pageSize: 25,
  },
  "sleep": {
    kind: "interval",
    field: "sleep",
    dateMember: "civil_end_time",
    rfc3339Member: "end_time",
    pageSize: 25,
  },
  "nutrition-log": {
    kind: "interval",
    field: "nutrition_log",
    dateMember: "civil_start_time",
    pageSize: 10000,
  },
  "heart-rate": { kind: "sample", field: "heart_rate", pageSize: 10000 },
  "weight": { kind: "sample", field: "weight", pageSize: 10000 },
  "body-fat": { kind: "sample", field: "body_fat", pageSize: 10000 },
};

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** RFC3339 の日時形式 (rollup サブコマンドの --from/--to 検証でも再利用する)。 */
export const RFC3339_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * label (--from/--to) の値を Date.parse し、ミリ秒値を返す。
 * 形式が一致していても 2026-13-01T00:00:00Z のような実在しない日時は Date.parse が NaN を返すため、ここで検出する。
 */
function assertRealDateTime(label: "--from" | "--to", value: string): number {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`${label} が実在する日時ではない: ${value}`);
  }
  return ms;
}

type ValueFormat = "date" | "rfc3339";

function detectFormat(value: string): ValueFormat {
  if (DATE_ONLY_RE.test(value)) {
    // 2026-02-31 のような不在日付を弾く (civil.ts の parseCivilDate に検査を委ねる)。
    parseCivilDate(value);
    return "date";
  }
  if (RFC3339_RE.test(value)) {
    return "rfc3339";
  }
  throw new Error(
    `--from/--to は YYYY-MM-DD または RFC3339 のいずれかで指定する: ${value}`,
  );
}

/**
 * dataType・from・to から filter 文字列を組み立てる。
 * interval 型は from/to の形式ごとに DATA_TYPE_FILTER_FIELDS のメンバーを使い、非対応の組み合わせ (例: exercise + RFC3339) はエラーにする。
 * sample 型 (heart-rate) は RFC3339 のみ受け付け、日付形式ならエラーにする。
 */
export function buildFilter(
  dataType: string,
  from: string,
  to: string,
): string {
  const entry = DATA_TYPE_FILTER_FIELDS[dataType];
  if (entry === undefined) {
    throw new Error(
      `未対応の dataType: ${dataType} (対応: ${
        Object.keys(DATA_TYPE_FILTER_FIELDS).join(", ")
      })`,
    );
  }

  const fromFormat = detectFormat(from);
  const toFormat = detectFormat(to);
  if (fromFormat !== toFormat) {
    throw new Error(
      `--from/--to は同じ形式 (どちらも YYYY-MM-DD かどちらも RFC3339) で指定する: from=${from}, to=${to}`,
    );
  }
  const fromMs = assertRealDateTime("--from", from);
  const toMs = assertRealDateTime("--to", to);
  if (fromMs >= toMs) {
    throw new Error(
      `--from は --to より前でなければならない (exclusive): from=${from} が to=${to} 以降になっている`,
    );
  }

  if (entry.kind === "sample") {
    if (fromFormat !== "rfc3339") {
      throw new Error(
        `${dataType} は RFC3339 (例: 2026-04-20T00:00:00Z) でのみ指定できる。日付形式は使えない: from=${from}, to=${to}`,
      );
    }
    return `${entry.field}.sample_time.physical_time >= "${from}" AND ${entry.field}.sample_time.physical_time < "${to}"`;
  }

  const member = fromFormat === "date" ? entry.dateMember : entry.rfc3339Member;
  if (member === undefined) {
    if (fromFormat === "date") {
      throw new Error(
        `${dataType} は RFC3339 (例: 2026-04-20T00:00:00Z) でのみ指定できる。日付形式は使えない: from=${from}, to=${to}`,
      );
    }
    throw new Error(
      `${dataType} は日付 (YYYY-MM-DD) でのみ指定できる。RFC3339 は使えない: from=${from}, to=${to}`,
    );
  }

  return `${entry.field}.interval.${member} >= "${from}" AND ${entry.field}.interval.${member} < "${to}"`;
}

/**
 * rollup サブコマンドの --from/--to (RFC3339 必須) を検査する。
 * 日付形式・不正な文字列 (RFC3339_RE に一致しない)、および from >= to はリクエスト前にエラーにする。
 */
export function validateRfc3339Range(from: string, to: string): void {
  if (!RFC3339_RE.test(from)) {
    throw new Error(
      `--from は RFC3339 で指定する (例: 2026-04-20T00:00:00Z): ${from}`,
    );
  }
  if (!RFC3339_RE.test(to)) {
    throw new Error(
      `--to は RFC3339 で指定する (例: 2026-04-20T00:00:00Z): ${to}`,
    );
  }
  const fromMs = assertRealDateTime("--from", from);
  const toMs = assertRealDateTime("--to", to);
  if (fromMs >= toMs) {
    throw new Error(
      `--from は --to より前でなければならない (exclusive): from=${from} が to=${to} 以降になっている`,
    );
  }
}
