/**
 * 内部 API サーバーの共通型定義。
 */

import type { Client } from "discord.js";

/**
 * Discord API ハンドラに渡すコンテキスト。
 *
 * discord.js Client とギルド ID を保持し、
 * 各ハンドラがこれを通じて Discord API を操作する。
 */
export interface ApiContext {
  /** discord.js Client インスタンス。 */
  client: Client;
  /** 操作対象のギルド ID。 */
  guildId: string;
}
