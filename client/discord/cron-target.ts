/**
 * cron 実行器 (`cron/executor.ts`) の {@link CronPorts} を Discord で実装する。
 *
 * channelId の解決・送信・ギルド由来のテンプレート変数・承認コールバックを
 * discord.js / `ApprovalManager` へ結びつける。
 *
 * @module
 */

import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { Client, GuildTextBasedChannel } from "discord.js";
import type { CronPorts } from "../../cron/executor.ts";
import { type ApprovalManager, createCanUseTool } from "./approval/manager.ts";
import { splitMessage } from "./message.ts";

/** {@link createDiscordCronPorts} の依存。 */
export interface DiscordCronPortsDeps {
  client: Client;
  guildId: string;
  approvalManager: ApprovalManager;
}

/**
 * Discord 向けの {@link CronPorts} を生成する。
 */
export function createDiscordCronPorts(deps: DiscordCronPortsDeps): CronPorts {
  const { client, guildId, approvalManager } = deps;

  return {
    async resolveTarget(channelId: string) {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !("send" in channel)) {
        throw new Error(`channel ${channelId} not found or not a text channel`);
      }
      const textChannel = channel as GuildTextBasedChannel;
      return {
        async send(text: string): Promise<void> {
          for (const chunk of splitMessage(text)) {
            await textChannel.send(chunk);
          }
        },
      };
    },

    // テンプレート変数はギルドレベルのみ（cron にはユーザー/チャンネルコンテキストが無い）
    guildTemplateVars(): Record<string, string> {
      const guild = client.guilds.cache.get(guildId);
      return {
        "discord.guild.id": guildId,
        "discord.guild.name": guild?.name ?? "",
      };
    },

    createCanUseTool(channelId: string | undefined): CanUseTool {
      return createCanUseTool(approvalManager, channelId);
    },
  };
}
