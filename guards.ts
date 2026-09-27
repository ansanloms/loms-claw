/**
 * リポジトリ横断で使う共通の type guard。
 *
 * @module
 */

/**
 * value が（配列ではない）オブジェクトかどうかの型ガード。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
