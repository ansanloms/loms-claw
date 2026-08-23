/**
 * Discord のチャンネル / スレッドから {@link StoreScope} を組み立てる。
 *
 * `bot/mod.ts` (message.channel から) と `bot/commands.ts`
 * (interaction.channel から) の両方が同じ形を組んでいたため、ここに集約する。
 */

import type { StoreScope } from "../store/mod.ts";

/**
 * {@link scopeFromChannel} が要求する最小のチャンネル形。
 *
 * discord.js の `isThread()` は `this is ThreadChannel` の TS type guard だが、
 * ここでは独自の最小インターフェース (`isThread(): boolean`) を受け取るため、
 * この関数の内部では type guard によるナローイングは効かない。`parentId` を
 * optional にしているのは、DMChannel 等 `parentId` を持たないチャンネル型を
 * 構造的に受け入れるため (discord.js の `Message["channel"]` /
 * `Interaction["channel"]` の union にはそうした型も含まれる)。実際に
 * `channel.parentId` を参照するのは `isThread()` が真の分岐のみで、その場合
 * discord.js 側の実体には常に `parentId` が存在する。
 */
export interface ScopeChannel {
  readonly parentId?: string | null;
  isThread(): boolean;
}

/**
 * チャンネル (またはスレッド) から {@link StoreScope} を組み立てる。
 *
 * - スレッド: `{ channelId: channel.parentId ?? fallbackChannelId, threadId: fallbackChannelId }`
 * - 通常チャンネル (または channel が取得できない場合): `{ channelId: fallbackChannelId }`
 *
 * `fallbackChannelId` には呼び出し元がすでに持っている channel/thread の ID
 * (`message.channelId` / `interaction.channelId`) を渡す。thread の parentId が
 * null のケース (フォーラム親が消えた等の異常系) では、この ID 自体を
 * channelId にフォールバックさせ、Store の整合性を保つ。
 */
export function scopeFromChannel(
  channel: ScopeChannel | null | undefined,
  fallbackChannelId: string,
): StoreScope {
  if (channel?.isThread()) {
    return {
      channelId: channel.parentId ?? fallbackChannelId,
      threadId: fallbackChannelId,
    };
  }
  return { channelId: fallbackChannelId };
}
