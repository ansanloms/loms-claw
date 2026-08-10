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
