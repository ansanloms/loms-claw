/**
 * チャンネル/スレッド単位のセッション管理。
 *
 * Discord のチャンネル ID をキーに、Claude Code の session_id を保持する。
 * `--resume` フラグで会話を継続する際に使う。
 *
 * コンストラクタに `filePath` を渡すと JSON ファイルに永続化し、
 * プロセス再起動後もセッションを復元できる。
 * 省略した場合はインメモリのみで動作する。
 */

import { dirname } from "node:path";
import { createLogger } from "../logger.ts";

const log = createLogger("session");

/**
 * セッションストア。
 */
export class SessionStore {
  private sessions = new Map<string, string>();
  private filePath: string | undefined;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      this.loadSync();
    }
  }

  /** チャンネル/スレッド ID からセッション ID を取得する。 */
  get(channelId: string): string | undefined {
    return this.sessions.get(channelId);
  }

  /** チャンネル/スレッド ID にセッション ID を紐づける。 */
  set(channelId: string, sessionId: string): void {
    this.sessions.set(channelId, sessionId);
    this.persist();
  }

  /** チャンネル/スレッド ID のセッションを削除する。 */
  delete(channelId: string): boolean {
    const result = this.sessions.delete(channelId);
    this.persist();
    return result;
  }

  /** 全セッションを削除する。 */
  clear(): void {
    this.sessions.clear();
    this.persist();
  }

  /** ファイルからセッションを復元する。 */
  private loadSync(): void {
    try {
      const text = Deno.readTextFileSync(this.filePath!);
      const data: unknown = JSON.parse(text);
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        for (
          const [key, value] of Object.entries(data as Record<string, unknown>)
        ) {
          if (typeof value === "string") {
            this.sessions.set(key, value);
          }
        }
      }
      log.info(`loaded ${this.sessions.size} session(s) from ${this.filePath}`);
    } catch (error: unknown) {
      if (error instanceof Deno.errors.NotFound) {
        log.info(`session file not found, starting empty: ${this.filePath}`);
        return;
      }
      log.warn(`failed to load session file, starting empty: ${error}`);
    }
  }

  /** セッションをファイルに書き込む。 */
  private persist(): void {
    if (!this.filePath) {
      return;
    }
    try {
      const dir = dirname(this.filePath);
      Deno.mkdirSync(dir, { recursive: true });
      const json = JSON.stringify(
        Object.fromEntries(this.sessions),
        null,
        2,
      );
      Deno.writeTextFileSync(this.filePath, json + "\n");
    } catch (error: unknown) {
      log.error(`failed to persist sessions: ${error}`);
    }
  }
}
