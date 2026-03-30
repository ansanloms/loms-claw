/**
 * コンテキスト別システムプロンプトの解決。
 *
 * ワークスペースの .claude/system-prompt/ 配下のファイルを起動時に読み込み、
 * コンテキスト（chat/vc）とチャンネル ID に応じて結合して返す。
 *
 * ファイル構成:
 *   DEFAULT.md              — 常に読み込む
 *   CHAT.md                 — テキストチャット時に読み込む
 *   VC.md                   — VC 時に読み込む
 *   {{CHANNEL_ID}}.md       — 特定チャンネルで応答する際に読み込む
 */

import { basename, join } from "jsr:@std/path@^1";
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
 * システムプロンプトの起動時キャッシュ。
 *
 * コンストラクタでディレクトリを指定し、loadSync() で全ファイルを読み込む。
 * resolve() はキャッシュから同期的に結合結果を返すため、メッセージ/発話ごとの I/O が発生しない。
 * ファイル変更の反映にはボット再起動が必要。
 */
export class SystemPromptStore {
  private defaultPrompt: string | undefined;
  private chatPrompt: string | undefined;
  private vcPrompt: string | undefined;
  private channelPrompts = new Map<string, string>();

  constructor(private readonly dir: string) {}

  /**
   * .claude/system-prompt/ 配下のファイルを全て読み込んでキャッシュする。
   * ディレクトリが存在しない場合は何もしない。
   */
  async load(): Promise<void> {
    this.defaultPrompt = (await readFileOrUndefined(
      join(this.dir, "DEFAULT.md"),
    ))?.trim() || undefined;
    this.chatPrompt = (await readFileOrUndefined(
      join(this.dir, "CHAT.md"),
    ))?.trim() || undefined;
    this.vcPrompt = (await readFileOrUndefined(
      join(this.dir, "VC.md"),
    ))?.trim() || undefined;

    // チャンネル ID ファイル（数値のみの .md ファイル）をスキャンする。
    try {
      for await (const entry of Deno.readDir(this.dir)) {
        if (!entry.isFile || !entry.name.endsWith(".md")) {
          continue;
        }
        const name = basename(entry.name, ".md");
        // DEFAULT, CHAT, VC は既に読み込み済み。
        if (name === "DEFAULT" || name === "CHAT" || name === "VC") {
          continue;
        }
        const content = (await readFileOrUndefined(
          join(this.dir, entry.name),
        ))?.trim();
        if (content) {
          this.channelPrompts.set(name, content);
          log.info(`loaded channel prompt: ${entry.name}`);
        }
      }
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        log.info("system-prompt directory not found, skipping");
        return;
      }
      throw e;
    }

    const count = (this.defaultPrompt ? 1 : 0) +
      (this.chatPrompt ? 1 : 0) +
      (this.vcPrompt ? 1 : 0) +
      this.channelPrompts.size;
    log.info(`loaded ${count} system prompt file(s) from ${this.dir}`);
  }

  /**
   * コンテキストに応じたシステムプロンプトをキャッシュから組み立てる。
   *
   * 読み込み順:
   * 1. DEFAULT.md — 常に含める
   * 2. CHAT.md or VC.md — コンテキストに応じて含める
   * 3. {channelId}.md — チャンネル固有の指示
   *
   * @param context - "chat" または "vc"。
   * @param channelId - Discord チャンネル ID。
   * @returns 結合されたシステムプロンプト。全不在なら undefined。
   */
  resolve(context: PromptContext, channelId: string): string | undefined {
    const parts: string[] = [];

    if (this.defaultPrompt) {
      parts.push(this.defaultPrompt);
    }

    const contextPrompt = context === "chat" ? this.chatPrompt : this.vcPrompt;
    if (contextPrompt) {
      parts.push(contextPrompt);
    }

    const channelPrompt = this.channelPrompts.get(channelId);
    if (channelPrompt) {
      parts.push(channelPrompt);
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined;
  }
}
