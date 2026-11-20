/**
 * セッション間の依頼 (内部 API の `POST /sessions/...`) を、対象スコープの
 * 会話ターンとしてキューに積む。
 *
 * 依頼の対象は設定のギルドに属するテキスト系のチャンネル / スレッドに限る。
 * 発話者とテンプレート変数は自己メンションと同じく認可ユーザーで組み、応答は
 * 対象のチャンネル / スレッドへ投稿する (起点のメッセージが無いので、メンションも
 * ⏳ も付けない)。
 *
 * @module
 */

import {
  type Channel,
  type Client,
  type GuildTextBasedChannel,
  PermissionFlagsBits,
} from "discord.js";
import type {
  SessionSubmitResult,
  SessionTarget,
} from "../../api/routes/sessions.ts";
import type { Conversation } from "../../core/conversation.ts";
import type { SelfMentionRateLimiter } from "../../core/ratelimit.ts";
import { createLogger } from "../../logger.ts";
import { scopeFromChannel } from "./scope.ts";
import {
  buildTemplateVars,
  createTurnOutput,
  resolveSpeaker,
} from "./turn-output.ts";

const log = createLogger("session-request");

/** {@link submitSessionRequest} の依存。 */
export interface SessionRequestDeps {
  client: Pick<Client, "channels" | "users">;
  /** 設定のギルド ID。これに属さないチャンネルは対象にしない。 */
  guildId: string;
  /** 認可ユーザーの ID (発話者として扱う)。 */
  userId: string;
  conversation: Pick<Conversation, "submit">;
  /** セッション間の依頼のレート制限 (自己メンションとは別枠)。受付時に消費する。 */
  limiter: Pick<SelfMentionRateLimiter, "tryConsume">;
  /** bot が終了処理に入っているか。入っていれば依頼を受け付けない。 */
  isClosed: () => boolean;
}

/**
 * 対象を取得し、設定のギルドに属する送信可能なテキスト系チャンネルなら返す。
 * 取得の失敗 (REST の reject)・存在しない ID・条件を満たさない種別は null。
 */
async function resolveTargetChannel(
  target: SessionTarget,
  deps: SessionRequestDeps,
): Promise<GuildTextBasedChannel | null> {
  const id = target.threadId ?? target.channelId;
  let fetched: Channel | null;
  try {
    fetched = await deps.client.channels.fetch(id);
  } catch (e) {
    log.warn(`failed to fetch channel ${id}:`, e);
    return null;
  }
  if (!fetched) {
    return null;
  }
  if (!fetched.isTextBased() || fetched.isDMBased() || !fetched.isSendable()) {
    return null;
  }
  const channel: GuildTextBasedChannel = fetched;
  if (channel.guildId !== deps.guildId) {
    return null;
  }
  if (target.threadId !== undefined) {
    // スレッドは親が URL の channelId と一致するものだけ。
    if (!channel.isThread() || channel.parentId !== target.channelId) {
      return null;
    }
  } else if (channel.isThread()) {
    // channelId の経路でスレッドを指されると、スコープの親子が崩れる。
    return null;
  }
  return canBotSend(channel) ? channel : null;
}

/**
 * bot がそのチャンネル / スレッドへ送信できるか。`isSendable()` は `send` メソッドの
 * 有無しか見ないので、権限を `permissionsFor()` で確かめる。
 *
 * - チャンネル: ViewChannel と SendMessages。
 * - スレッド: ViewChannel と SendMessagesInThreads (スレッドの権限は親チャンネルの
 *   `permissionsFor()` に委譲される。親が引けなければ null)。ロック中のスレッドは
 *   送れないものとして扱う。アーカイブ済みは判定に入れない (送信で解除されるかは
 *   discord.js のソースから確認できないため)。
 */
function canBotSend(channel: GuildTextBasedChannel): boolean {
  const permissions = channel.permissionsFor(channel.client.user);
  if (!permissions) {
    return false;
  }
  if (channel.isThread()) {
    return (
      !channel.locked &&
      permissions.has(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.SendMessagesInThreads)
    );
  }
  return (
    permissions.has(PermissionFlagsBits.ViewChannel) &&
    permissions.has(PermissionFlagsBits.SendMessages)
  );
}

/**
 * 依頼を対象スコープのキューに積む。ターンの完了は待たない。
 *
 * - 終了処理中なら `unavailable` (宛先の検証・枠の消費より前に判定する)。
 * - 対象が設定のギルドの送信可能なテキスト系でなければ `not-found`。
 * - 依頼用のレート枠をここで消費し、尽きていれば `rate-limited`。受け付けた (`accepted`)
 *   依頼は、ターンとしてキューに積まれて実行を始める。
 * - それ以外は `accepted`。ターンの失敗は `log.error` に落とす。
 */
export async function submitSessionRequest(
  target: SessionTarget,
  prompt: string,
  source: string | undefined,
  deps: SessionRequestDeps,
): Promise<SessionSubmitResult> {
  if (deps.isClosed()) {
    return "unavailable";
  }
  const channel = await resolveTargetChannel(target, deps);
  if (!channel) {
    return "not-found";
  }
  // 宛先の取得中に終了処理が始まった場合も、枠を消費せずに断る。
  if (deps.isClosed()) {
    return "unavailable";
  }
  if (!deps.limiter.tryConsume()) {
    return "rate-limited";
  }

  const localId = target.threadId ?? target.channelId;
  const scope = scopeFromChannel(channel, localId);

  const speaker = resolveSpeaker({
    isSelfMessage: true,
    authorId: deps.userId,
    authorDisplayName: "",
    authorizedUserId: deps.userId,
    lookupDisplayName: (userId) =>
      channel.guild.members.cache.get(userId)?.displayName ??
      deps.client.users.cache.get(userId)?.displayName,
  });
  const templateVars = buildTemplateVars({
    guildId: deps.guildId,
    guildName: channel.guild.name,
    localId,
    channelName: channel.name,
    isThread: channel.isThread(),
    speaker,
  });

  deps.conversation
    .submit(
      {
        scope,
        localId,
        prompt,
        isSelfMessage: false,
        templateVars,
        sessionRequest: source === undefined ? {} : { source },
      },
      createTurnOutput({
        channel,
        isSelfMessage: false,
        hasAttachments: false,
      }),
    )
    .catch((e: unknown) => {
      log.error(`failed to process session request in ${localId}:`, e);
    });

  return "accepted";
}
