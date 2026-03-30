/**
 * コンテキスト別システムプロンプトの解決。
 *
 * ワークスペースの .claude/system-prompt/ 配下のファイルを読み込み、
 * コンテキスト（chat/vc）とチャンネル ID に応じて結合して返す。
 *
 * ファイル構成:
 *   DEFAULT.md              — 常に読み込む
 *   CHAT.md                 — テキストチャット時に読み込む
 *   VC.md                   — VC 時に読み込む
 *   {{CHANNEL_ID}}.md       — 特定チャンネルで応答する際に読み込む
 */

import { join } from "jsr:@std/path@^1/join";
import { createLogger } from "../logger.ts";

const log = createLogger("system-prompt");

/**
 * システムプロンプトのコンテキスト種別。
 */
export type PromptContext = "chat" | "vc";

/**
 * ファイルを読み込む。存在しなければ undefined を返す。
 */
async function readFileOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await Deno.readTextFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw e;
  }
}

/**
 * コンテキストに応じたシステムプロンプトを組み立てる。
 *
 * .claude/system-prompt/ 配下のファイルを以下の順序で読み込み、
 * 改行 2 つで結合して返す。ファイルが存在しない場合はスキップする。
 *
 * 1. DEFAULT.md — 常に読み込む
 * 2. CHAT.md or VC.md — コンテキストに応じて読み込む
 * 3. {channelId}.md — チャンネル固有の指示
 *
 * @param cwd - ワークスペースのルートディレクトリ。
 * @param context - "chat" または "vc"。
 * @param channelId - Discord チャンネル ID。
 * @returns 結合されたシステムプロンプト。全ファイル不在なら undefined。
 */
export async function resolveSystemPrompt(
  cwd: string,
  context: PromptContext,
  channelId: string,
): Promise<string | undefined> {
  const dir = join(cwd, ".claude", "system-prompt");
  const contextFile = context === "chat" ? "CHAT.md" : "VC.md";

  const parts: string[] = [];

  const files = [
    join(dir, "DEFAULT.md"),
    join(dir, contextFile),
    join(dir, `${channelId}.md`),
  ];

  for (const file of files) {
    const content = await readFileOrUndefined(file);
    if (content?.trim()) {
      parts.push(content.trim());
      log.debug(`loaded system prompt: ${file}`);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("\n\n");
}
