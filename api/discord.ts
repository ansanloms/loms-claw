/**
 * Discord REST API ハンドラ。
 *
 * discord.js Client を通じて Discord API を操作する
 * HTTP ハンドラ関数群を提供する。
 */

import { ChannelType, type Guild } from "discord.js";
import type { ApiContext } from "./types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("api-discord");

/**
 * JSON 成功レスポンスを生成する。
 */
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * JSON エラーレスポンスを生成する。
 */
function errorResponse(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * ApiContext からギルドを取得する。見つからなければエラー。
 */
async function fetchGuild(ctx: ApiContext): Promise<Guild> {
  const guild = await ctx.client.guilds.fetch(ctx.guildId);
  if (!guild) {
    throw new Error(`Guild not found: ${ctx.guildId}`);
  }
  return guild;
}

/**
 * チャンネルがギルド内に属することを検証し、テキストチャンネルを返す。
 */
async function fetchGuildTextChannel(ctx: ApiContext, channelId: string) {
  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }
  if (!("guildId" in channel) || channel.guildId !== ctx.guildId) {
    throw new Error(
      `Channel ${channelId} does not belong to guild ${ctx.guildId}`,
    );
  }
  if (!("send" in channel)) {
    throw new Error(`Channel ${channelId} is not a text-based channel`);
  }
  return channel;
}

/**
 * GET /discord/channels
 *
 * ギルド内のチャンネル一覧を取得する。
 */
export async function listChannels(
  req: Request,
  ctx: ApiContext,
): Promise<Response> {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "all";

  log.debug("listChannels:", type);
  const guild = await fetchGuild(ctx);
  const channels = await guild.channels.fetch();

  const typeMap: Record<string, ChannelType[]> = {
    text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
    voice: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
    category: [ChannelType.GuildCategory],
  };

  const filtered = type === "all"
    ? [...channels.values()]
    : [...channels.values()].filter((ch) =>
      ch && typeMap[type]?.includes(ch.type)
    );

  const list = filtered
    .filter((ch) => ch !== null)
    .map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ChannelType[ch.type],
      parent_id: "parentId" in ch ? ch.parentId : null,
    }));

  return jsonResponse(list);
}

/**
 * GET /discord/channels/:id
 *
 * チャンネルの詳細情報を取得する。
 */
export async function getChannelInfo(
  _req: Request,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const channelId = params.id;
  log.debug("getChannelInfo:", channelId);

  const channel = await ctx.client.channels.fetch(channelId);
  if (!channel) {
    return errorResponse(`Channel not found: ${channelId}`, 404);
  }
  if (!("guildId" in channel) || channel.guildId !== ctx.guildId) {
    return errorResponse(
      `Channel ${channelId} does not belong to guild ${ctx.guildId}`,
      403,
    );
  }

  const info: Record<string, unknown> = {
    id: channel.id,
    type: ChannelType[channel.type],
  };

  if ("name" in channel) {
    info.name = channel.name;
  }
  if ("topic" in channel && channel.topic) {
    info.topic = channel.topic;
  }
  if ("parentId" in channel && channel.parentId) {
    info.parent_id = channel.parentId;
  }
  if ("nsfw" in channel) {
    info.nsfw = channel.nsfw;
  }

  return jsonResponse(info);
}

/**
 * POST /discord/channels/:id/messages
 *
 * 指定チャンネルにメッセージを送信する。
 */
export async function sendMessage(
  req: Request,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const channelId = params.id;
  const body = await req.json();
  const content = body?.content;

  if (!content || typeof content !== "string") {
    return errorResponse("content is required", 400);
  }

  log.debug("sendMessage:", channelId, content.slice(0, 50));
  const channel = await fetchGuildTextChannel(ctx, channelId);
  const msg = await channel.send(content);

  return jsonResponse({ id: msg.id, channel_id: channelId });
}

/**
 * GET /discord/channels/:id/messages?query=&author_id=&limit=
 *
 * チャンネル内のメッセージを検索する。
 */
export async function searchMessages(
  req: Request,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const channelId = params.id;
  const url = new URL(req.url);
  const query = url.searchParams.get("query") ?? undefined;
  const authorId = url.searchParams.get("author_id") ?? undefined;
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? "25"), 1),
    100,
  );

  log.debug("searchMessages:", channelId, query, authorId);
  const channel = await fetchGuildTextChannel(ctx, channelId);
  if (!("messages" in channel)) {
    return errorResponse(
      `Channel ${channelId} does not support messages`,
      400,
    );
  }

  const messages = await channel.messages.fetch({ limit });

  let filtered = [...messages.values()];
  if (query) {
    const lowerQuery = query.toLowerCase();
    filtered = filtered.filter((m) =>
      m.content.toLowerCase().includes(lowerQuery)
    );
  }
  if (authorId) {
    filtered = filtered.filter((m) => m.author.id === authorId);
  }

  const results = filtered.map((m) => ({
    id: m.id,
    author: {
      id: m.author.id,
      username: m.author.username,
      display_name: m.author.displayName,
    },
    content: m.content,
    created_at: m.createdAt.toISOString(),
  }));

  return jsonResponse(results);
}

/**
 * GET /discord/channels/:id/messages/:mid
 *
 * 指定メッセージの内容を取得する。
 */
export async function getMessage(
  _req: Request,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const channelId = params.id;
  const messageId = params.mid;

  log.debug("getMessage:", channelId, messageId);
  const channel = await fetchGuildTextChannel(ctx, channelId);
  if (!("messages" in channel)) {
    return errorResponse(
      `Channel ${channelId} does not support messages`,
      400,
    );
  }

  const message = await channel.messages.fetch(messageId);

  const info = {
    id: message.id,
    author: {
      id: message.author.id,
      username: message.author.username,
      display_name: message.author.displayName,
      bot: message.author.bot,
    },
    content: message.content,
    created_at: message.createdAt.toISOString(),
    edited_at: message.editedAt?.toISOString() ?? null,
    attachments: message.attachments.map((a) => ({
      name: a.name,
      url: a.url,
      size: a.size,
    })),
    reactions: message.reactions.cache.map((r) => ({
      emoji: r.emoji.toString(),
      count: r.count,
    })),
  };

  return jsonResponse(info);
}

/**
 * POST /discord/channels/:cid/messages/:mid/reactions
 *
 * メッセージにリアクションを追加する。
 */
export async function addReaction(
  req: Request,
  ctx: ApiContext,
  params: Record<string, string>,
): Promise<Response> {
  const channelId = params.cid;
  const messageId = params.mid;
  const body = await req.json();
  const emoji = body?.emoji;

  if (!emoji || typeof emoji !== "string") {
    return errorResponse("emoji is required", 400);
  }

  log.debug("addReaction:", channelId, messageId, emoji);
  const channel = await fetchGuildTextChannel(ctx, channelId);
  if (!("messages" in channel)) {
    return errorResponse(
      `Channel ${channelId} does not support messages`,
      400,
    );
  }

  const message = await channel.messages.fetch(messageId);
  await message.react(emoji);

  return jsonResponse({ message_id: messageId, emoji });
}

/**
 * GET /discord/members?query=&limit=
 *
 * ギルドメンバーを一覧/検索する。
 */
export async function getGuildMembers(
  req: Request,
  ctx: ApiContext,
): Promise<Response> {
  const url = new URL(req.url);
  const query = url.searchParams.get("query") ?? undefined;
  const limit = Math.min(
    Math.max(Number(url.searchParams.get("limit") ?? "25"), 1),
    100,
  );

  log.debug("getGuildMembers:", query);
  const guild = await fetchGuild(ctx);

  const members = query
    ? await guild.members.fetch({ query, limit })
    : await guild.members.fetch({ limit });

  const list = [...members.values()].map((m) => ({
    id: m.id,
    username: m.user.username,
    display_name: m.displayName,
    bot: m.user.bot,
    joined_at: m.joinedAt?.toISOString() ?? null,
    roles: m.roles.cache
      .filter((r) => r.name !== "@everyone")
      .map((r) => ({ id: r.id, name: r.name })),
  }));

  return jsonResponse(list);
}
