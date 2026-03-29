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
  if (guildId !== config.guildId) {
    return false;
  }
  if (userId !== config.authorizedUserId) {
    return false;
  }
  return true;
}

/**
 * メッセージに反応すべきか判定する。
 *
 * - activeChannelIds に含まれるチャンネル → 全メッセージ
 * - スレッドの親チャンネルが active → mention 不要
 * - それ以外 → bot mention 必須
 */
export function shouldRespond(
  channelId: string,
  activeChannelIds: string[],
  isThread: boolean,
  parentId: string | null,
  isMentioned: boolean,
): boolean {
  if (activeChannelIds.includes(channelId)) {
    return true;
  }

  if (isThread && parentId && activeChannelIds.includes(parentId)) {
    return true;
  }

  return isMentioned;
}
