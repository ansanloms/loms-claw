/**
 * コンテキスト別システムプロンプトの解決。
 *
 * ワークスペースの .claude/system-prompt/ 配下のファイルを起動時に読み込み、
 * コンテキスト（chat/vc/cron）とスコープ (channelId / threadId) に応じて
 * 結合して返す。
 *
 * ファイル構成:
 *   DEFAULT.md              — 常に読み込む
 *   CHAT.md                 — テキストチャット時に読み込む
 *   VC.md                   — VC 時に読み込む
 *   CRON.md                 — cron ジョブ時に読み込む
 *   {{CHANNEL_ID}}.md       — 特定チャンネル / スレッドで応答する際に読み込む
 *
 * スコープ単位ファイルの解決順 (Store の model/effort と同じ動的フォールバック):
 *   1. {threadId}.md  (スレッド固有プロンプト)
 *   2. {channelId}.md (親チャンネルプロンプト)
 *   3. なし
 *
 * thread と channel は Discord の同一 Snowflake 名前空間で衝突しないため、
 * channelPrompts は単一の Map<id, string> で両方を保持する。
 */

import { basename, join } from "jsr:@std/path@^1";
import { createLogger } from "../logger.ts";
import { replaceTemplateVariables } from "./template.ts";

const log = createLogger("system-prompt");

/**
 * システムプロンプトのコンテキスト種別。
 */
export type PromptContext = "chat" | "vc" | "cron";

/**
 * システムプロンプトの解決スコープ。
 * `Store` の StoreScope と同形式: thread → channel のフォールバックチェーンを表す。
 */
export interface PromptScope {
  channelId: string;
  threadId?: string;
}

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
  private cronPrompt: string | undefined;
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
    this.cronPrompt = (await readFileOrUndefined(
      join(this.dir, "CRON.md"),
    ))?.trim() || undefined;

    // チャンネル固有ファイルをスキャンする。
    // DEFAULT.md, CHAT.md, VC.md 以外の .md ファイルは
    // ファイル名（拡張子除く）をチャンネル ID として扱う。
    // Discord のチャンネル ID は数値文字列（Snowflake）。
    this.channelPrompts.clear();
    try {
      for await (const entry of Deno.readDir(this.dir)) {
        if (!entry.isFile || !entry.name.endsWith(".md")) {
          continue;
        }
        const name = basename(entry.name, ".md");
        if (
          name === "DEFAULT" || name === "CHAT" || name === "VC" ||
          name === "CRON"
        ) {
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
   * コンテキストとスコープに応じたシステムプロンプトをキャッシュから組み立てる。
   *
   * 読み込み順:
   * 1. DEFAULT.md — 常に含める
   * 2. CHAT.md / VC.md / CRON.md — コンテキストに応じて含める
   * 3. スコープ別ファイル — thread → channel の動的フォールバックで 1 件のみ
   *    - `{threadId}.md` があればそれ
   *    - 無ければ `{channelId}.md`
   *    - どちらも無ければスキップ
   *
   * @param context - "chat" / "vc" / "cron"。
   * @param scope - 解決スコープ。`{ channelId, threadId? }`。
   * @param vars - テンプレート変数。`{{key}}` を値で置換する。
   * @returns 結合されたシステムプロンプト。全不在なら undefined。
   */
  resolve(
    context: PromptContext,
    scope: PromptScope,
    vars?: Record<string, string>,
  ): string | undefined {
    const parts: string[] = [];

    if (this.defaultPrompt) {
      parts.push(this.defaultPrompt);
    }

    const contextPrompt = context === "chat"
      ? this.chatPrompt
      : context === "vc"
      ? this.vcPrompt
      : this.cronPrompt;
    if (contextPrompt) {
      parts.push(contextPrompt);
    }

    // thread → channel のフォールバックで 1 件のみ採用 (両方は重ねない)。
    // 重ねないのは「スレッド固有指示で親チャンネル指示を上書きしたい」
    // ケースを想定し、Store の model/effort 解決と挙動を揃えるため。
    const scopePrompt =
      (scope.threadId !== undefined
        ? this.channelPrompts.get(scope.threadId)
        : undefined) ?? this.channelPrompts.get(scope.channelId);
    if (scopePrompt) {
      parts.push(scopePrompt);
    }

    if (parts.length === 0) {
      return undefined;
    }

    const joined = parts.join("\n\n");
    return vars ? replaceTemplateVariables(joined, vars) : joined;
  }
}
