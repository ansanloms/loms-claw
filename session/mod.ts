/**
 * チャンネル/スレッド単位のセッション管理。
 *
 * Discord のチャンネル ID をキーに、Claude Code の session_id を保持する。
 * `--resume` フラグで会話を継続する際に使う。
 * インメモリ実装のため、プロセス再起動でセッションは消える。
 */

/**
 * セッションストア。
 */
export class SessionStore {
  private sessions = new Map<string, string>();

  /** チャンネル/スレッド ID からセッション ID を取得する。 */
  get(channelId: string): string | undefined {
    return this.sessions.get(channelId);
  }

  /** チャンネル/スレッド ID にセッション ID を紐づける。 */
  set(channelId: string, sessionId: string): void {
    this.sessions.set(channelId, sessionId);
  }

  /** チャンネル/スレッド ID のセッションを削除する。 */
  delete(channelId: string): boolean {
    return this.sessions.delete(channelId);
  }

  /** 全セッションを削除する。 */
  clear(): void {
    this.sessions.clear();
  }
}
