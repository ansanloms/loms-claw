/**
 * 1 ターン分の Discord 向け出力 ({@link TurnOutput}) と、その入力になる
 * 発話者・テンプレート変数の組み立て。
 *
 * `DiscordBot` から切り出した関数群。`resolveSpeaker` / `buildTemplateVars` は
 * 純粋関数。`createTurnOutput` は `Message` の一部のメンバー (`TurnMessage`) と
 * `GuildTextBasedChannel` を受け取り、副作用 (画像の取得・後始末) は
 * `TurnOutputDeps` で差し替えられる。
 */

import type {
  GuildTextBasedChannel,
  Message,
  MessageReaction,
} from "discord.js";
import type { TurnOutput } from "../../core/conversation.ts";
import { summarizeError } from "../../errors.ts";
import { createLogger } from "../../logger.ts";
import {
  appendImageReferences,
  cleanupImageFiles,
  createProgressReporter,
  DISCORD_MESSAGE_LIMIT,
  type DownloadedImage,
  downloadImageAttachments,
  keepTyping,
  runTurnCleanup,
  splitMessage,
} from "./message.ts";

const log = createLogger("turn-output");

/** テンプレート変数の発話者。 */
export interface Speaker {
  id: string;
  name: string;
}

/**
 * テンプレート変数の発話者を決める。
 *
 * 自己メンション起動時の message.author は自 bot だが、そのまま渡すと
 * 「発話者へメンションせよ」というプロンプト指示が `<@botId>` を生み、
 * 自己メンションの再発火 (連鎖) につながる。自己起動時は認可ユーザー (本人) を
 * 発話者として渡す。
 *
 * 人間のメッセージの表示名は、ギルドメンバーの表示名 (ニックネーム優先) があれば
 * それを使い、無ければ投稿者のグローバル表示名にする。自己メンション起動時の
 * 認可ユーザーの表示名 (`lookupDisplayName`) と同じ解決順にそろえるため。
 *
 * @param memberDisplayName - `message.member?.displayName` (キャッシュに無ければ undefined)。
 * @param lookupDisplayName - 自己起動時に認可ユーザーの表示名を引く関数 (見つからなければ undefined)。
 */
export function resolveSpeaker(args: {
  isSelfMessage: boolean;
  authorId: string;
  authorDisplayName: string;
  memberDisplayName?: string;
  authorizedUserId: string;
  lookupDisplayName: (userId: string) => string | undefined;
}): Speaker {
  if (!args.isSelfMessage) {
    return {
      id: args.authorId,
      name: args.memberDisplayName ?? args.authorDisplayName,
    };
  }
  return {
    id: args.authorizedUserId,
    name:
      args.lookupDisplayName(args.authorizedUserId) ?? args.authorizedUserId,
  };
}

/** システムプロンプトのテンプレート変数 (`discord.*`) を組み立てる。 */
export function buildTemplateVars(args: {
  guildId: string;
  guildName: string;
  localId: string;
  channelName: string;
  isThread: boolean;
  speaker: Speaker;
}): Record<string, string> {
  return {
    "discord.guild.id": args.guildId,
    "discord.guild.name": args.guildName,
    "discord.channel.id": args.localId,
    "discord.channel.name": args.channelName,
    "discord.channel.type": args.isThread ? "thread" : "text",
    "discord.user.id": args.speaker.id,
    "discord.user.name": args.speaker.name,
  };
}

/** {@link createTurnOutput} が使う `Message` のメンバー。 */
export type TurnMessage = Pick<Message, "author" | "react" | "attachments">;

/** {@link createTurnOutput} の副作用の注入点 (テスト用)。既定は message.ts の実装。 */
export interface TurnOutputDeps {
  downloadImages: typeof downloadImageAttachments;
  cleanupImages: typeof cleanupImageFiles;
}

/** {@link createTurnOutput} の引数。 */
export interface TurnOutputArgs {
  /**
   * 起点の Discord メッセージ。セッション間の依頼 (内部 API) のように起点が
   * 無いときは省略する。省略時はメンションを付けず、⏳ も添付も扱わない。
   */
  message?: TurnMessage;
  channel: GuildTextBasedChannel;
  isSelfMessage: boolean;
  hasAttachments: boolean;
  deps?: TurnOutputDeps;
}

/**
 * 1 ターン分の出力先 ({@link TurnOutput}) を Discord 向けに組み立てる。
 *
 * typing・進捗 reporter・ダウンロードした画像はターン単位の状態なので、
 * ターンごとにこの関数のクロージャで持つ。
 */
export function createTurnOutput(args: TurnOutputArgs): TurnOutput {
  const { message, channel, isSelfMessage, hasAttachments } = args;
  const { downloadImages, cleanupImages } = args.deps ?? {
    downloadImages: downloadImageAttachments,
    cleanupImages: cleanupImageFiles,
  };
  const typingController = new AbortController();
  let progress: ReturnType<typeof createProgressReporter> | undefined;
  let downloadedImages: DownloadedImage[] = [];
  // onQueued で付けた ⏳ の react の結果 (失敗は undefined)。onTurnStart が待って外す。
  let queuedReaction: Promise<MessageReaction | undefined> | undefined;

  // 応答は発言者宛にする: 分割後のすべての投稿の先頭にメンションを付ける。
  // メンション分を引いた上限で分割してから各チャンク先頭に付与することで、
  // どのチャンクでも上限ぎりぎりでメンション分が溢れない（2000 字超過しない）。
  // 自己メッセージ起動時は空文字にする: 応答冒頭に自 bot メンションを付けると、
  // 応答自体が再度メンション条件を満たし連鎖の火種になるため。
  // 発話者 (認可ユーザー) へのピングは Client 既定の allowedMentions で通る。
  // 起点のメッセージが無いときも、宛先が居ないので空文字にする。
  const mention = isSelfMessage || !message ? "" : `<@${message.author.id}> `;
  const sendChunks = async (text: string): Promise<void> => {
    const chunks = splitMessage(text, DISCORD_MESSAGE_LIMIT - mention.length);
    for (const chunk of chunks) {
      await channel.send(mention + chunk);
    }
  };

  return {
    onQueued: () => {
      if (!message) {
        return;
      }
      // 待機に入ったことを発言者へ可視化する。失敗は致命的でないので警告ログに残し、
      // undefined に解決させる。
      // react は await せず Promise を保持する (Conversation.submit の
      // isBusy 判定と enqueue の間に await を挟まないため)。
      queuedReaction = message.react("⏳").catch((e) => {
        log.warn("⏳ リアクションを付けられなかった:", e);
        return undefined;
      });
    },

    onTurnStart: async () => {
      // 自分のターンが始まったら待機マーカー (⏳) を外す。react の完了は待たず
      // (滞ってもターンを止めない)、解決したら戻り値から外す。remove() の引数を
      // 省くと discord.js は client.user を使う。reactions.cache は引かない。
      void queuedReaction?.then((reaction) =>
        reaction?.users.remove().catch((e) => {
          log.warn("⏳ リアクションを外せなかった:", e);
        }),
      );

      // typing インジケーター開始
      keepTyping(channel, typingController.signal);

      progress = createProgressReporter(channel);
    },

    // 画像添付をダウンロード（画像フィルタは downloadImageAttachments 内で行う）
    preparePrompt: async (prompt) => {
      if (!message || !hasAttachments) {
        return prompt;
      }
      downloadedImages = await downloadImages(message.attachments.values());
      if (downloadedImages.length > 0) {
        return appendImageReferences(
          prompt || "この画像について説明して",
          downloadedImages,
        );
      }
      return prompt;
    },

    sendReply: sendChunks,

    // thinking (推論) を引用形式で投稿する。回答ではないのでメンションは付けず、
    // Discord の `> ` 引用で回答と視覚的に分離する。
    sendThinking: async (text) => {
      const quoted = text
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      for (const chunk of splitMessage(quoted)) {
        await channel.send(chunk);
      }
    },

    reportProgress: async (toolName, elapsedSeconds) => {
      await progress?.report(toolName, elapsedSeconds);
    },

    // エラーもまだ何も送っていなければ発言者宛にする（content 送出済みなら継続扱い）。
    // Discord へは要約のみ送り、全文はログ (GET /logs) を参照させる。
    notifyError: (error) => sendChunks(summarizeError(error)),

    onTurnEnd: async () => {
      await runTurnCleanup(
        () => typingController.abort(),
        [
          async () => {
            if (downloadedImages.length > 0) {
              await cleanupImages(downloadedImages);
            }
          },
          async () => {
            await progress?.cleanup();
          },
        ],
      );
    },
  };
}
