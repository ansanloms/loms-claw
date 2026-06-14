/**
 * Discord REST API ルート。
 *
 * discord.js Client を通じて Discord API を操作する
 * HTTP エンドポイント群を提供する。
 */

import { Hono } from "hono";
import { ChannelType, type Guild } from "discord.js";
import type { FromSchema } from "json-schema-to-ts";
import type { ApiContext } from "../types.ts";
import { internalSchemas } from "../internal-schemas.ts";
import { matchesSchema, schemaErrorOf } from "../validate.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-discord");

/**
 * ApiContext からギルドを取得する。
 */
async function fetchGuild(ctx: ApiContext): Promise<Guild> {
  return await ctx.client.guilds.fetch(ctx.guildId);
}

/**
 * Discord UI と同じデフォルト (24h)。60 (1h) だと運用上短すぎるため、
 * auto_archive_duration 省略時に補う。
 */
const DEFAULT_AUTO_ARCHIVE_DURATION = 1440;

type ThreadCreateBody = FromSchema<typeof internalSchemas["RequestPostThread"]>;

interface ParsedThreadCreateBody {
  name: string;
  autoArchiveDuration: NonNullable<ThreadCreateBody["auto_archive_duration"]>;
  reason: string | undefined;
}

/** request body が RequestPostMessage スキーマに適合するかの型ガード。 */
function isPostMessageBody(
  value: unknown,
): value is FromSchema<typeof internalSchemas["RequestPostMessage"]> {
  return matchesSchema("RequestPostMessage", value);
}

/** request body が RequestPostReaction スキーマに適合するかの型ガード。 */
function isPostReactionBody(
  value: unknown,
): value is FromSchema<typeof internalSchemas["RequestPostReaction"]> {
  return matchesSchema("RequestPostReaction", value);
}

/** request body が RequestPostThread スキーマに適合するかの型ガード。 */
function isThreadCreateBody(value: unknown): value is ThreadCreateBody {
  return matchesSchema("RequestPostThread", value);
}

/**
 * スレッド作成 API の request body を docs/api の OpenAPI スキーマ
 * (RequestPostThread) で構造検証し、正規化する。
 * `channel.threads.create()` / `message.startThread()` 双方で使用する。
 *
 * 型・長さ (1〜100)・auto_archive_duration の enum・余剰フィールド拒否は
 * スキーマ検証が担う。空白のみの name 拒否と auto_archive_duration の既定値
 * 補完は OpenAPI に表現できないためここに残す。
 */
function parseThreadCreateBody(
  body: unknown,
): { ok: true; value: ParsedThreadCreateBody } | {
  ok: false;
  error: string;
} {
  if (!isThreadCreateBody(body)) {
    return { ok: false, error: schemaErrorOf("RequestPostThread", body) };
  }
  if (body.name.trim().length === 0) {
    return { ok: false, error: "name must not be blank" };
  }

  return {
    ok: true,
    value: {
      name: body.name,
      autoArchiveDuration: body.auto_archive_duration ??
        DEFAULT_AUTO_ARCHIVE_DURATION,
      reason: body.reason,
    },
  };
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

    if (!isPostMessageBody(body)) {
      return c.json({ error: schemaErrorOf("RequestPostMessage", body) }, 400);
    }
    const { content } = body;

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

    if (!isPostReactionBody(body)) {
      return c.json({ error: schemaErrorOf("RequestPostReaction", body) }, 400);
    }
    const { emoji } = body;

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

  // POST /channels/:id/threads
  app.post("/channels/:id/threads", async (c) => {
    const channelId = c.req.param("id");
    const body = await c.req.json();
    const parsed = parseThreadCreateBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    log.debug("createThread:", channelId, parsed.value.name);
    const channel = await fetchGuildTextChannel(ctx, channelId);
    if (!("threads" in channel)) {
      return c.json(
        { error: `Channel ${channelId} does not support threads` },
        400,
      );
    }

    const thread = await channel.threads.create({
      name: parsed.value.name,
      autoArchiveDuration: parsed.value.autoArchiveDuration,
      reason: parsed.value.reason,
    });

    return c.json({
      id: thread.id,
      name: thread.name,
      parent_id: thread.parentId,
    });
  });

  // POST /channels/:cid/messages/:mid/threads
  app.post("/channels/:cid/messages/:mid/threads", async (c) => {
    const { cid: channelId, mid: messageId } = c.req.param();
    const body = await c.req.json();
    const parsed = parseThreadCreateBody(body);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    log.debug(
      "startThreadFromMessage:",
      channelId,
      messageId,
      parsed.value.name,
    );
    const channel = await fetchGuildTextChannel(ctx, channelId);
    if (!("messages" in channel)) {
      return c.json(
        { error: `Channel ${channelId} does not support messages` },
        400,
      );
    }
    // 親が既にスレッドの場合は派生スレッドを作れない (Discord 仕様)。
    // チャンネル直下版と挙動を揃えるため事前に弾く。
    if (!("threads" in channel)) {
      return c.json(
        { error: `Channel ${channelId} does not support threads` },
        400,
      );
    }

    const message = await channel.messages.fetch(messageId);
    const thread = await message.startThread({
      name: parsed.value.name,
      autoArchiveDuration: parsed.value.autoArchiveDuration,
      reason: parsed.value.reason,
    });

    return c.json({
      id: thread.id,
      name: thread.name,
      parent_id: thread.parentId,
    });
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
