/**
 * batch-delete サブコマンドのリクエストボディ組み立て。
 * body の形 (`{"names": [...]}`) は 2026-09-27 実測 (nutrition-log) で確認済み。
 * 他のデータ型で形が違うと分かれば、ここだけ直せばよい。
 */

/** `dataPoints:batchDelete` の body (`{"names": [...]}`) を組み立てる。 */
export function buildBatchDeleteBody(
  names: readonly string[],
): { names: readonly string[] } {
  return { names };
}
