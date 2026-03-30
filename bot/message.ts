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

/** スロットル間隔（ミリ秒）。Discord の message.edit() レート制限（5回/5秒）を考慮。 */
const PROGRESS_THROTTLE_MS = 3000;

/**
 * ツール実行の進捗を Discord メッセージで表示する。
 *
 * Discord の message.edit() レート制限を考慮し、最短 3 秒間隔でスロットルする。
 * 返り値の `report` で進捗を更新し、`cleanup` で進捗メッセージを削除する。
 */
export function createProgressReporter(channel: GuildTextBasedChannel): {
  report: (toolName: string, elapsedSeconds: number) => Promise<void>;
  cleanup: () => Promise<void>;
} {
  let message: Awaited<ReturnType<GuildTextBasedChannel["send"]>> | null = null;
  let lastUpdate = 0;

  return {
    async report(toolName, elapsedSeconds) {
      const now = Date.now();
      if (now - lastUpdate < PROGRESS_THROTTLE_MS) {
        return;
      }

      // 並行呼び出し時の二重 send を防ぐため、await 前に更新
      lastUpdate = now;

      const text = `\`${toolName}\` 実行中... (${Math.round(elapsedSeconds)}s)`;

      if (!message) {
        message = await channel.send(text);
      } else {
        await message.edit(text).catch(() => {});
      }
    },

    async cleanup() {
      if (message) {
        await message.delete().catch(() => {});
        message = null;
      }
    },
  };
}
