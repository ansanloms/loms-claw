/**
 * Discord MCP サーバーの共通型定義。
 */

import type { Client } from "discord.js";

/**
 * MCP ツールハンドラに渡すコンテキスト。
 *
 * discord.js Client とギルド ID を保持し、
 * 各ツールがこれを通じて Discord API を操作する。
 */
export interface McpContext {
  /** discord.js Client インスタンス。 */
  client: Client;
  /** 操作対象のギルド ID。 */
  guildId: string;
}
