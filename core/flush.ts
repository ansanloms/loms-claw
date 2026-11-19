/**
 * ストリーミング応答のバッファを文境界でフラッシュする純粋関数。
 *
 * `flushBuffer` (回答テキスト) と `flushThinking` (thinking) が共有する
 * アルゴリズムをここに集約する。discord.js への依存を持たない。
 */

/**
 * バッファを文境界 (`。` または改行) で分割する。
 *
 * - `force` が true なら境界を無視してバッファ全体を送る対象にする。
 * - `force` が false のとき、最後の文境界が見つかればそこで区切る。
 * - 境界が見つからず、かつバッファ長が `threshold` の 2 倍以上なら強制フラッシュ
 *   (コードブロック・英語テキスト・URL 等、文境界が連続しないケースへの対策)。
 * - 境界が見つからず `threshold` の 2 倍未満なら、状態を変えずに `null` を返す
 *   (呼び出し側はバッファをそのまま維持する)。
 *
 * `null` 以外を返す場合は常に `rest` を新しいバッファ値として採用すること。
 * `send` が空文字列 (trim 後に空) でも `rest` の反映は必要 (境界より前の
 * 空白のみの断片を捨てるケース)。
 *
 * @param buffer 現在のバッファ内容
 * @param threshold フラッシュ閾値 (境界なし時の強制判定に 2 倍として使う)
 * @param force true なら境界を無視して全部を送る対象にする
 * @returns 送る部分 (`send`, trim 済み) と残す部分 (`rest`) のペア。
 *   バッファを変更しない場合は `null`。
 */
export function splitAtBoundary(
  buffer: string,
  threshold: number,
  force: boolean,
): { send: string; rest: string } | null {
  if (force) {
    return { send: buffer.trim(), rest: "" };
  }

  const lastBoundary = Math.max(
    buffer.lastIndexOf("。"),
    buffer.lastIndexOf("\n"),
  );
  if (lastBoundary < 0) {
    if (buffer.length >= threshold * 2) {
      return splitAtBoundary(buffer, threshold, true);
    }
    return null;
  }

  return {
    send: buffer.slice(0, lastBoundary + 1).trim(),
    rest: buffer.slice(lastBoundary + 1),
  };
}
