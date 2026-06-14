/**
 * エラーハンドリングの共通ユーティリティ。
 */

/**
 * unknown なエラー値からメッセージ文字列を取り出す。
 *
 * `catch` で受けた値は unknown なので、`Error` ならその `message`、
 * それ以外は `String()` で文字列化して返す。
 */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
