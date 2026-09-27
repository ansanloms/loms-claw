/**
 * rollup サブコマンドの `--window` (`30s` / `5m` / `1h` 等) を、API が要求する秒単位の
 * Duration 文字列 (`"<秒>s"`) に正規化する。
 */

const WINDOW_RE = /^(\d+)(s|m|h)$/;
const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600 };

/** `<数値>s` / `<数値>m` / `<数値>h` 形式を秒に換算し `"<秒>s"` の Duration 文字列にする。不正な形式・0 秒は例外。 */
export function normalizeWindowSize(value: string): string {
  const m = WINDOW_RE.exec(value);
  if (m === null) {
    throw new Error(
      `--window は <数値>s / <数値>m / <数値>h の形式で指定する (例: 30s, 5m, 1h): ${value}`,
    );
  }
  const [, countStr, unit] = m;
  const seconds = Number(countStr) * UNIT_SECONDS[unit];
  if (seconds === 0) {
    throw new Error(`--window は 0 秒にできない: ${value}`);
  }
  return `${seconds}s`;
}
