/**
 * Discord メッセージ送信ユーティリティ。
 *
 * 2000 文字制限の分割送信と、typing インジケーター維持を提供する。
 */

import type { GuildTextBasedChannel } from "discord.js";

/**
 * Discord のメッセージ文字数上限。
 */
const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * テキストを Discord の文字数制限に収まるように分割する。
 *
 * 分割の優先順:
 * 1. 改行位置（後半に存在する場合）
 * 2. 強制分割（制限文字数で切る）
 */
export function splitMessage(
  text: string,
  limit: number = DISCORD_MESSAGE_LIMIT,
): string[] {
  if (text.length <= limit) {
    return [text];
  }

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    // 後半の改行位置を探す
    const newline = rest.lastIndexOf("\n", limit);
    const cut = newline > limit / 2 ? newline : limit;

    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }

  if (rest) {
    chunks.push(rest);
  }

  return chunks;
}

/**
 * typing インジケーターを維持する。
 *
 * Discord の typing インジケーターは約 10 秒で消えるため、
 * 10 秒ごとに `sendTyping()` を呼び続ける。
 * AbortSignal で停止する。
 *
 * @param channel - typing を送信するチャンネル
 * @param signal - 停止用 AbortSignal
 */
export function keepTyping(
  channel: GuildTextBasedChannel,
  signal: AbortSignal,
): void {
  if (signal.aborted) {
    return;
  }

  // 初回の typing 送信
  channel.sendTyping().catch(() => {});

  const id = setInterval(() => {
    if (signal.aborted) {
      clearInterval(id);
      return;
    }
    channel.sendTyping().catch(() => {});
  }, 10_000);

  signal.addEventListener("abort", () => clearInterval(id), { once: true });
}
