/**
 * Discord REST API ルート。
 *
 * discord.js Client を通じて Discord API を操作する
 * HTTP エンドポイント群を提供する。
 */

import { Hono } from "hono";
import { ChannelType, type Guild } from "discord.js";
import type { ApiContext } from "../types.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-discord");

/**
 * ApiContext からギルドを取得する。
 */
async function fetchGuild(ctx: ApiContext): Promise<Guild> {
  return await ctx.client.guilds.fetch(ctx.guildId);
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
 * Discord API ルートを生成する。
 */
export function createDiscordRoutes(ctx: ApiContext) {
  const app = new Hono();

  // GET /channels
  app.get("/channels", async (c) => {
    const type = c.req.query("type") ?? "all";

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

    return c.json(list);
  });

  // GET /channels/:id
  app.get("/channels/:id", async (c) => {
    const channelId = c.req.param("id");
    log.debug("getChannelInfo:", channelId);

    const channel = await ctx.client.channels.fetch(channelId);
    if (!channel) {
      return c.json({ error: `Channel not found: ${channelId}` }, 404);
    }
    if (!("guildId" in channel) || channel.guildId !== ctx.guildId) {
      return c.json(
        {
          error: `Channel ${channelId} does not belong to guild ${ctx.guildId}`,
        },
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

    return c.json(info);
  });

  // GET /channels/:id/messages
  app.get("/channels/:id/messages", async (c) => {
    const channelId = c.req.param("id");
    const query = c.req.query("query") ?? undefined;
    const authorId = c.req.query("author_id") ?? undefined;
    const limit = Math.min(
      Math.max(Number(c.req.query("limit") ?? "25"), 1),
      100,
    );

    log.debug("searchMessages:", channelId, query, authorId);
    const channel = await fetchGuildTextChannel(ctx, channelId);
    if (!("messages" in channel)) {
      return c.json(
        { error: `Channel ${channelId} does not support messages` },
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

    return c.json(results);
  });

  // POST /channels/:id/messages
  app.post("/channels/:id/messages", async (c) => {
    const channelId = c.req.param("id");
    const body = await c.req.json();
    const content = body?.content;

    if (!content || typeof content !== "string") {
      return c.json({ error: "content is required" }, 400);
    }

    log.debug("sendMessage:", channelId, content.slice(0, 50));
    const channel = await fetchGuildTextChannel(ctx, channelId);
    const msg = await channel.send(content);

    return c.json({ id: msg.id, channel_id: channelId });
  });

  // GET /channels/:id/messages/:mid
  app.get("/channels/:id/messages/:mid", async (c) => {
    const { id: channelId, mid: messageId } = c.req.param();

    log.debug("getMessage:", channelId, messageId);
    const channel = await fetchGuildTextChannel(ctx, channelId);
    if (!("messages" in channel)) {
      return c.json(
        { error: `Channel ${channelId} does not support messages` },
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

    return c.json(info);
  });

  // POST /channels/:cid/messages/:mid/reactions
  app.post("/channels/:cid/messages/:mid/reactions", async (c) => {
    const { cid: channelId, mid: messageId } = c.req.param();
    const body = await c.req.json();
    const emoji = body?.emoji;

    if (!emoji || typeof emoji !== "string") {
      return c.json({ error: "emoji is required" }, 400);
    }

    log.debug("addReaction:", channelId, messageId, emoji);
    const channel = await fetchGuildTextChannel(ctx, channelId);
    if (!("messages" in channel)) {
      return c.json(
        { error: `Channel ${channelId} does not support messages` },
        400,
      );
    }

    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);

    return c.json({ message_id: messageId, emoji });
  });

  // GET /members
  app.get("/members", async (c) => {
    const query = c.req.query("query") ?? undefined;
    const limit = Math.min(
      Math.max(Number(c.req.query("limit") ?? "25"), 1),
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

    return c.json(list);
  });

  return app;
}
