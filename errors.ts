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

/** Discord へのエラー要約投稿で 1 行に許容する最大文字数。 */
const DISCORD_ERROR_SUMMARY_MAX_LENGTH = 200;

/**
 * unknown なエラー値を Discord への投稿向けに要約する。
 *
 * 全文はログ (`log.error`) に残す前提で、Discord へは定型文と
 * エラーメッセージの先頭 1 行 (改行までを最大 200 文字に切ったもの) のみを返す。
 */
export function summarizeErrorForDiscord(error: unknown): string {
  const message = getErrorMessage(error);
  const firstLine = message.split(/\r?\n/)[0];
  const truncated = firstLine.length > DISCORD_ERROR_SUMMARY_MAX_LENGTH
    ? firstLine.slice(0, DISCORD_ERROR_SUMMARY_MAX_LENGTH)
    : firstLine;
  return `処理に失敗した。詳細はログ (\`GET /logs\`) を参照\n${truncated}`;
}
