/**
 * Discord MCP ツールの定義と登録。
 *
 * McpServer に Discord 操作ツールを登録するファクトリ関数を提供する。
 * 各ツールは McpContext（discord.js Client + guildId）をクロージャ経由で参照する。
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { ChannelType, type Guild } from "discord.js";
import type { McpContext } from "./types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("mcp-tools");

/**
 * McpContext からギルドを取得する。見つからなければエラー。
 */
async function fetchGuild(ctx: McpContext): Promise<Guild> {
  const guild = await ctx.client.guilds.fetch(ctx.guildId);
  if (!guild) {
    throw new Error(`Guild not found: ${ctx.guildId}`);
  }
  return guild;
}

/**
 * チャンネルがギルド内に属することを検証し、テキストチャンネルを返す。
 */
async function fetchGuildTextChannel(ctx: McpContext, channelId: string) {
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
 * ツール結果のテキストレスポンスを生成する。
 */
function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * MCP サーバーを生成し、Discord 操作ツールを登録する。
 *
 * stateless モードで使うため、リクエストごとに新しいインスタンスを生成する。
 */
export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer({
    name: "loms-claw-discord",
    version: "1.0.0",
  });

  // --- discord_send_message ---
  server.registerTool(
    "discord_send_message",
    {
      description: "指定チャンネルにメッセージを送信する。",
      inputSchema: {
        channel_id: z.string().describe("送信先チャンネル ID"),
        content: z.string().describe("メッセージ内容"),
      },
    },
    async (
      { channel_id, content }: { channel_id: string; content: string },
    ) => {
      log.debug("discord_send_message:", channel_id, content.slice(0, 50));
      const channel = await fetchGuildTextChannel(ctx, channel_id);
      const msg = await channel.send(content);
      return textResult(`Message sent: ${msg.id}`);
    },
  );

  // --- discord_get_channel_info ---
  server.registerTool("discord_get_channel_info", {
    description: "チャンネルの詳細情報を取得する。",
    inputSchema: {
      channel_id: z.string().describe("チャンネル ID"),
    },
  }, async ({ channel_id }: { channel_id: string }) => {
    log.debug("discord_get_channel_info:", channel_id);
    const channel = await ctx.client.channels.fetch(channel_id);
    if (!channel) {
      throw new Error(`Channel not found: ${channel_id}`);
    }
    if (!("guildId" in channel) || channel.guildId !== ctx.guildId) {
      throw new Error(
        `Channel ${channel_id} does not belong to guild ${ctx.guildId}`,
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

    return textResult(JSON.stringify(info, null, 2));
  });

  // --- discord_list_channels ---
  server.registerTool("discord_list_channels", {
    description: "ギルド内のチャンネル一覧を取得する。",
    inputSchema: {
      type: z.enum(["text", "voice", "category", "all"]).optional().describe(
        "フィルタするチャンネル種別（デフォルト: all）",
      ),
    },
  }, async ({ type }: { type?: string }) => {
    log.debug("discord_list_channels:", type);
    const guild = await fetchGuild(ctx);
    const channels = await guild.channels.fetch();

    const typeFilter = type ?? "all";
    const typeMap: Record<string, ChannelType[]> = {
      text: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      voice: [ChannelType.GuildVoice, ChannelType.GuildStageVoice],
      category: [ChannelType.GuildCategory],
    };

    const filtered = typeFilter === "all"
      ? [...channels.values()]
      : [...channels.values()].filter((ch) =>
        ch && typeMap[typeFilter]?.includes(ch.type)
      );

    const list = filtered
      .filter((ch) => ch !== null)
      .map((ch) => ({
        id: ch.id,
        name: ch.name,
        type: ChannelType[ch.type],
        parent_id: "parentId" in ch ? ch.parentId : null,
      }));

    return textResult(JSON.stringify(list, null, 2));
  });

  // --- discord_add_reaction ---
  server.registerTool("discord_add_reaction", {
    description: "メッセージにリアクション（絵文字）を追加する。",
    inputSchema: {
      channel_id: z.string().describe("チャンネル ID"),
      message_id: z.string().describe("メッセージ ID"),
      emoji: z.string().describe(
        "絵文字（Unicode 絵文字またはカスタム絵文字 <:name:id>）",
      ),
    },
  }, async (
    { channel_id, message_id, emoji }: {
      channel_id: string;
      message_id: string;
      emoji: string;
    },
  ) => {
    log.debug("discord_add_reaction:", channel_id, message_id, emoji);
    const channel = await fetchGuildTextChannel(ctx, channel_id);
    if (!("messages" in channel)) {
      throw new Error(`Channel ${channel_id} does not support messages`);
    }
    const message = await channel.messages.fetch(message_id);
    await message.react(emoji);
    return textResult(`Reaction ${emoji} added to message ${message_id}`);
  });

  // --- discord_get_message ---
  server.registerTool("discord_get_message", {
    description: "指定メッセージの内容を取得する。",
    inputSchema: {
      channel_id: z.string().describe("チャンネル ID"),
      message_id: z.string().describe("メッセージ ID"),
    },
  }, async (
    { channel_id, message_id }: { channel_id: string; message_id: string },
  ) => {
    log.debug("discord_get_message:", channel_id, message_id);
    const channel = await fetchGuildTextChannel(ctx, channel_id);
    if (!("messages" in channel)) {
      throw new Error(`Channel ${channel_id} does not support messages`);
    }
    const message = await channel.messages.fetch(message_id);

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

    return textResult(JSON.stringify(info, null, 2));
  });

  // --- discord_search_messages ---
  server.registerTool("discord_search_messages", {
    description:
      "チャンネル内のメッセージを検索する。直近のメッセージから取得しフィルタする。",
    inputSchema: {
      channel_id: z.string().describe("チャンネル ID"),
      query: z.string().optional().describe("メッセージ内容の部分一致フィルタ"),
      author_id: z.string().optional().describe("投稿者 ID でフィルタ"),
      limit: z.number().min(1).max(100).optional().describe(
        "取得件数（デフォルト: 25, 最大: 100）",
      ),
    },
  }, async (
    { channel_id, query, author_id, limit }: {
      channel_id: string;
      query?: string;
      author_id?: string;
      limit?: number;
    },
  ) => {
    log.debug("discord_search_messages:", channel_id, query, author_id);
    const channel = await fetchGuildTextChannel(ctx, channel_id);
    if (!("messages" in channel)) {
      throw new Error(`Channel ${channel_id} does not support messages`);
    }

    const fetchLimit = limit ?? 25;
    const messages = await channel.messages.fetch({ limit: fetchLimit });

    let filtered = [...messages.values()];
    if (query) {
      const lowerQuery = query.toLowerCase();
      filtered = filtered.filter((m) =>
        m.content.toLowerCase().includes(lowerQuery)
      );
    }
    if (author_id) {
      filtered = filtered.filter((m) => m.author.id === author_id);
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

    return textResult(JSON.stringify(results, null, 2));
  });

  // --- discord_get_guild_members ---
  server.registerTool("discord_get_guild_members", {
    description: "ギルドメンバーを一覧/検索する。",
    inputSchema: {
      query: z.string().optional().describe(
        "表示名またはユーザー名で検索（部分一致、空文字で全員）",
      ),
      limit: z.number().min(1).max(100).optional().describe(
        "取得件数（デフォルト: 25, 最大: 100）",
      ),
    },
  }, async ({ query, limit }: { query?: string; limit?: number }) => {
    log.debug("discord_get_guild_members:", query);
    const guild = await fetchGuild(ctx);
    const fetchLimit = limit ?? 25;

    const members = query
      ? await guild.members.fetch({ query, limit: fetchLimit })
      : await guild.members.fetch({ limit: fetchLimit });

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

    return textResult(JSON.stringify(list, null, 2));
  });

  return server;
}
