/**
 * `messageCreate` の分岐判定 (認可 → 自己メンション判定 (+ レート制限) →
 * スコープ抽出 → active 上書き取得 → 反応判定) を `bot/mod.ts` から切り出したもの。
 *
 * discord.js の `Message` / `Client` に直接触れず、呼び出し側 (`bot/mod.ts`)
 * が取り出した最小の値 (`IncomingMessageInput`) と、KV 読み取り・メンション判定・
 * レート制限といった副作用を持つ処理を関数として注入する (`IncomingMessageDeps`)。
 * ログ出力・キュー投入・Claude 呼び出しは従来どおり `bot/mod.ts` に残す。
 *
 * `isAuthorized` / `isAuthorizedSelfMessage` / `shouldRespond` / `scopeFromChannel`
 * の判定ロジック自体はここでは再実装せず、既存の純粋関数をそのまま呼ぶ。
 */

import type { Config } from "../config.ts";
import type { StoreScope } from "../store/mod.ts";
import {
  isAuthorized,
  isAuthorizedSelfMessage,
  shouldRespond,
} from "./guard.ts";
import { type ScopeChannel, scopeFromChannel } from "./scope.ts";

/**
 * `message.mentions.has()` に渡すオプションの最小形。
 */
export interface MentionCheckOptions {
  ignoreRepliedUser?: boolean;
  ignoreEveryone?: boolean;
  ignoreRoles?: boolean;
}

/**
 * {@link resolveIncomingMessage} が受け取る、メッセージから取り出した最小の値。
 */
export interface IncomingMessageInput {
  /** メッセージが送信されたギルドの ID (DM の場合は null)。 */
  guildId: string | null;
  /** 送信者のユーザー ID。 */
  authorId: string;
  /** 送信者が bot かどうか。 */
  authorIsBot: boolean;
  /** ログイン中の自 bot のユーザー ID (未ログインなら null)。 */
  botUserId: string | null;
  /** `scopeFromChannel()` に渡すチャンネル。 */
  channel: ScopeChannel | null | undefined;
  /** `message.channelId` (スレッドなら親ではなくスレッド自身の ID)。 */
  channelId: string;
  /** `message.channel.isThread()` の結果。 */
  isThread: boolean;
  /** スレッドの親チャンネル ID (スレッドでなければ null)。 */
  parentId: string | null;
  /** bot 以外のユーザーへの明示メンションが含まれるか。 */
  hasNonBotMentions: boolean;
}

/**
 * {@link resolveIncomingMessage} が呼び出す、discord.js / Store に依存する処理。
 */
export interface IncomingMessageDeps {
  config: Config;
  /**
   * 自 bot へのメンション判定。`message.mentions.has(client.user, opts)` 相当。
   * `client.user` が無ければ常に false を返すこと。
   */
  isMentioned: (opts: MentionCheckOptions) => boolean;
  /** そのスコープの active 上書き設定 (KV 読み取り)。未設定なら undefined。 */
  getActiveOverride: (scope: StoreScope) => Promise<boolean | undefined>;
  /** 自己メンション応答のレート枠が尽きているか (非消費の事前判定)。 */
  isSelfMentionRateLimited: () => boolean;
}

/**
 * 反応しないと判定した理由。
 */
export type IncomingIgnoreReason =
  | "unauthorized"
  | "self-not-mentioned"
  | "rate-limited"
  | "not-responding";

/**
 * `resolveIncomingMessage()` の判定結果。
 */
export type IncomingDecision =
  | { kind: "ignore"; reason: IncomingIgnoreReason }
  | {
    kind: "handle";
    scope: StoreScope;
    /** 発話があった場所 (スレッドならスレッド ID、そうでなければチャンネル ID)。 */
    localId: string;
    /** AI to AI 自己メンションで起動したターンかどうか。 */
    isSelfMessage: boolean;
  };

/**
 * 認可 → 自己メンション判定 (+ レート制限) → スコープ抽出 → active 上書き取得 →
 * 反応判定の順に評価し、メッセージを処理すべきか判定する。
 *
 * 自己メッセージは `active` を適用しない (メンション必須、レート制限のみ)。
 * 人間のメッセージは `shouldRespond()` (`bot/guard.ts`) に従う。
 */
export async function resolveIncomingMessage(
  input: IncomingMessageInput,
  deps: IncomingMessageDeps,
): Promise<IncomingDecision> {
  const isSelfMessage = isAuthorizedSelfMessage(
    input.guildId,
    input.authorId,
    input.botUserId,
    deps.config,
  );
  if (
    !isSelfMessage &&
    !isAuthorized(
      input.guildId,
      input.authorId,
      input.authorIsBot,
      deps.config,
    )
  ) {
    return { kind: "ignore", reason: "unauthorized" };
  }

  if (isSelfMessage) {
    // 本文中の `<@botId>` (返信ピング・@everyone・role メンションを除く) だけを
    // 明示メンションとみなす。
    const isMentioned = deps.isMentioned({
      ignoreRepliedUser: true,
      ignoreEveryone: true,
      ignoreRoles: true,
    });
    if (!isMentioned) {
      return { kind: "ignore", reason: "self-not-mentioned" };
    }
    if (deps.isSelfMentionRateLimited()) {
      return { kind: "ignore", reason: "rate-limited" };
    }
    const scope = scopeFromChannel(input.channel, input.channelId);
    return {
      kind: "handle",
      scope,
      localId: scope.threadId ?? scope.channelId,
      isSelfMessage: true,
    };
  }

  const scope = scopeFromChannel(input.channel, input.channelId);
  const isMentioned = deps.isMentioned({});
  const activeOverride = await deps.getActiveOverride(scope);

  if (
    !shouldRespond(
      input.channelId,
      deps.config.discord.activeChannelIds,
      input.isThread,
      input.parentId,
      isMentioned,
      input.hasNonBotMentions,
      activeOverride,
    )
  ) {
    return { kind: "ignore", reason: "not-responding" };
  }

  return {
    kind: "handle",
    scope,
    localId: scope.threadId ?? scope.channelId,
    isSelfMessage: false,
  };
}
