/**
 * メッセージの認可・反応判定。
 *
 * discord.js に依存しない純粋関数として実装し、単体テスト可能にする。
 */

import type { Config } from "../config.ts";

/**
 * メッセージの送信者が操作を許可されているか判定する。
 *
 * @param guildId - メッセージが送信されたギルドの ID（DM の場合は null）
 * @param userId - 送信者のユーザー ID
 * @param isBot - 送信者が bot かどうか
 * @param config - アプリケーション設定
 * @returns 操作が許可されていれば true
 */
export function isAuthorized(
  guildId: string | null,
  userId: string,
  isBot: boolean,
  config: Config,
): boolean {
  if (isBot) {
    return false;
  }
  if (guildId !== config.discord.guildId) {
    return false;
  }
  if (userId !== config.discord.userId) {
    return false;
  }
  return true;
}

/**
 * そのスコープが active (mention 不要で全メッセージに反応する) かを解決する。
 *
 * 解決順:
 *   1. override (KV の per-scope 設定) が boolean ならそれを採用する
 *   2. undefined なら config の activeChannelIds によるリスト判定へフォールバックする
 *      (スレッドの場合は親チャンネル ID も見る)
 *
 * override が false を明示すると、config で active なチャンネルでも mention
 * 必須へ落とせる。override が true を明示すると、config のリストに無いチャン
 * ネルでも mention 不要になる。
 *
 * 注意: フォーラムチャンネル (GuildForum) の ID を activeChannelIds に入れると、
 * 配下の全スレッド (= 全投稿) が mention 不要で自動応答対象になる。フォーラム
 * 自体にはメッセージが投稿できないため実害は小さいが、想定外の挙動を避ける
 * ため activeChannelIds には通常のテキストチャンネル ID のみを指定すること。
 */
export function resolveActive(
  channelId: string,
  activeChannelIds: string[],
  isThread: boolean,
  parentId: string | null,
  override: boolean | undefined,
): boolean {
  return override ?? (
    activeChannelIds.includes(channelId) ||
    (isThread && parentId !== null && activeChannelIds.includes(parentId))
  );
}

/**
 * メッセージに反応すべきか判定する。
 *
 * - resolveActive() が true を返すスコープ (KV の per-scope 上書き、または
 *   activeChannelIds によるリスト判定) → 原則全メッセージに反応
 *   - bot へのメンションがなく他ユーザーへのメンションがある場合は無視
 * - それ以外 → bot mention 必須
 *
 * KV の per-scope 上書き (activeOverride) は config の activeChannelIds より
 * 優先される。false を明示すると config で active なチャンネルでも mention
 * 必須へ落とせる。詳細な解決順は resolveActive() を参照。
 *
 * 注意: フォーラムチャンネル (GuildForum) の ID を activeChannelIds に入れると、
 * 配下の全スレッド (= 全投稿) が mention 不要で自動応答対象になる。フォーラム
 * 自体にはメッセージが投稿できないため実害は小さいが、想定外の挙動を避ける
 * ため activeChannelIds には通常のテキストチャンネル ID のみを指定すること。
 *
 * @param hasNonBotMentions - メッセージに bot 以外のユーザーメンションが含まれるか。
 *   @everyone や @role は対象外（discord.js の mentions.users にはユーザー個別メンションのみ含まれる）。
 * @param activeOverride - KV に保存された per-scope の active 上書き。未設定なら undefined。
 */
export function shouldRespond(
  channelId: string,
  activeChannelIds: string[],
  isThread: boolean,
  parentId: string | null,
  isMentioned: boolean,
  hasNonBotMentions: boolean,
  activeOverride?: boolean,
): boolean {
  const isActive = resolveActive(
    channelId,
    activeChannelIds,
    isThread,
    parentId,
    activeOverride,
  );

  if (isActive) {
    if (!isMentioned && hasNonBotMentions) {
      return false;
    }
    return true;
  }

  return isMentioned;
}

/**
 * 自 bot 自身が送信したメッセージ（自己メンション）を処理対象として認可するか判定する。
 *
 * `isAuthorized()` はユーザーメッセージ用であり、bot メッセージは常に拒否する。
 * 自己メンション機能は別スコープの自 bot が起動元になるため、この専用関数で
 * 「自 bot の user ID のみ・機能が有効・正しいギルド」を満たす場合のみ許可する。
 * 他 bot のメッセージは引き続き拒否する（isAuthorized 同様 fail-closed）。
 */
export function isAuthorizedSelfMessage(
  guildId: string | null,
  authorId: string,
  botUserId: string | null,
  config: Config,
): boolean {
  if (!config.discord.selfMention.enabled) {
    return false;
  }
  if (botUserId === null) {
    return false;
  }
  if (authorId !== botUserId) {
    return false;
  }
  if (guildId !== config.discord.guildId) {
    return false;
  }
  return true;
}

/**
 * メッセージ本文から `[hop:N]` ホップマーカーを取り出す。
 *
 * 最初に見つかったマーカーの N（10 進整数）を返す。マーカーが無い、数値として
 * 解釈できない、または N が 1 未満の場合は null を返す。
 *
 * 仕様: 正規表現 `/\[hop:(\d+)\]/` の最初の一致を採用する。一致した N が 1
 * 未満なら null（それ以降のマーカーは探索しない）。数値形式でない
 * `[hop:...]`（例: `[hop:abc]`）はそもそも正規表現に一致しないため読み飛ばされ、
 * 次に一致するマーカーが採用対象になる。
 */
export function parseHopMarker(content: string): number | null {
  const match = content.match(/\[hop:(\d+)\]/);
  if (!match) {
    return null;
  }
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  return n;
}

/**
 * 自 bot 自身のメッセージに反応すべきか判定する。
 *
 * 自己メッセージは active チャンネルであっても、明示メンション + 有効な
 * `[hop:N]` マーカーの両方が無い限り反応しない（fail-closed）。マーカーが無い
 * 自己メッセージ、あるいは hop がホップ上限を超える場合は無視する。
 * `activeOverride` が明示的に false の場合は、そのスコープにおける自己メンション
 * の per-scope kill switch として働き、mention・hop の条件を満たしていても無視する。
 */
export function shouldRespondToSelf(
  isMentioned: boolean,
  hop: number | null,
  maxHops: number,
  activeOverride: boolean | undefined,
): boolean {
  if (!isMentioned) {
    return false;
  }
  if (hop === null) {
    return false;
  }
  if (hop > maxHops) {
    return false;
  }
  if (activeOverride === false) {
    return false;
  }
  return true;
}
