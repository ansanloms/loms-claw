/**
 * チャンネル / スレッド単位の永続化ストア。
 *
 * Deno KV (SQLite backend) に session_id / model / effort を保存する。
 *
 * スコープは {channelId, threadId?} の組で表す。
 *   - threadId 無し: 通常チャンネル (= スレッドではないテキストチャンネル) または
 *     cron の擬似 channelId (`cron:{name}`) など。
 *   - threadId あり: スレッド。フォールバック先として親チャンネルを参照する。
 *
 * model / effort は thread → channel → defaults の順に解決する。
 * session は thread と channel で完全に独立し、互いにフォールバックしない。
 *
 * KV キー設計:
 *   ["channel", id, "session" | "model" | "effort"] -> string
 *   id は Discord Snowflake (channel / thread どちらも) または `cron:{name}`。
 *   thread と channel は同一 Snowflake 名前空間で衝突しないため、id をそのまま
 *   キーに使い分ける。
 *
 * @module
 */

const NS = "channel";
const SESSION = "session";
const MODEL = "model";
const EFFORT = "effort";

/**
 * グローバルデフォルト値。チャンネル / スレッド単位の上書きが無いときに使われる。
 */
export interface StoreDefaults {
  model?: string;
  effort?: string;
}

/**
 * 永続化スコープ。Discord のチャンネル、または親チャンネル + スレッドの組。
 */
export interface StoreScope {
  channelId: string;
  threadId?: string;
}

/**
 * スコープ設定値の出所。
 *   - thread:  スレッド固有の設定値
 *   - channel: 親チャンネルの設定値 (thread が未設定でフォールバック)
 *   - default: グローバルデフォルト
 */
export type SettingSource = "thread" | "channel" | "default";

/**
 * スコープの設定値とその出所を表すエントリ。
 */
export interface ScopeSettingEntry {
  value: string;
  source: SettingSource;
}

/**
 * スコープ単位の設定スナップショット。
 */
export interface ScopeSettings {
  session?: string;
  model?: ScopeSettingEntry;
  effort?: ScopeSettingEntry;
}

/**
 * Deno KV ベースのスコープ設定ストア。
 */
export class Store {
  constructor(
    private readonly kv: Deno.Kv,
    private readonly defaults: StoreDefaults = {},
  ) {}

  // ── session ─────────────────────────────────────────────
  // session は thread と channel で独立。フォールバックしない。

  async getSession(scope: StoreScope): Promise<string | undefined> {
    const id = scope.threadId ?? scope.channelId;
    const entry = await this.kv.get<string>([NS, id, SESSION]);
    return entry.value ?? undefined;
  }

  async setSession(scope: StoreScope, sessionId: string): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    await this.kv.set([NS, id, SESSION], sessionId);
  }

  async deleteSession(scope: StoreScope): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    await this.kv.delete([NS, id, SESSION]);
  }

  // ── model ───────────────────────────────────────────────
  // thread → channel → defaults の順で解決。

  async getModel(scope: StoreScope): Promise<string | undefined> {
    if (scope.threadId !== undefined) {
      const threadEntry = await this.kv.get<string>([
        NS,
        scope.threadId,
        MODEL,
      ]);
      if (threadEntry.value !== null) {
        return threadEntry.value;
      }
    }
    const channelEntry = await this.kv.get<string>([
      NS,
      scope.channelId,
      MODEL,
    ]);
    return channelEntry.value ?? this.defaults.model;
  }

  async setModel(scope: StoreScope, model: string): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    await this.kv.set([NS, id, MODEL], model);
  }

  async deleteModel(scope: StoreScope): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    await this.kv.delete([NS, id, MODEL]);
  }

  // ── effort ──────────────────────────────────────────────

  async getEffort(scope: StoreScope): Promise<string | undefined> {
    if (scope.threadId !== undefined) {
      const threadEntry = await this.kv.get<string>([
        NS,
        scope.threadId,
        EFFORT,
      ]);
      if (threadEntry.value !== null) {
        return threadEntry.value;
      }
    }
    const channelEntry = await this.kv.get<string>([
      NS,
      scope.channelId,
      EFFORT,
    ]);
    return channelEntry.value ?? this.defaults.effort;
  }

  async setEffort(scope: StoreScope, effort: string): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    await this.kv.set([NS, id, EFFORT], effort);
  }

  async deleteEffort(scope: StoreScope): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    await this.kv.delete([NS, id, EFFORT]);
  }

  // ── まとめ操作 ─────────────────────────────────────────

  /**
   * 指定スコープの session / model / effort を全削除する。
   * threadId 指定時は thread の設定のみ消し、親チャンネルの設定は残す。
   * threadId 未指定時はチャンネルの設定のみ消す (配下のスレッド設定は残る)。
   *
   * delete を atomic で 1 コミットにまとめる。`kv.list` 自体は atomic では
   * ないが、取得済みキーの削除を 1 トランザクションに集約することで「複数
   * キーが中途半端に残る」状態を防ぐ。
   */
  async clearScope(scope: StoreScope): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    const atomic = this.kv.atomic();
    for await (const entry of this.kv.list({ prefix: [NS, id] })) {
      atomic.delete(entry.key);
    }
    await atomic.commit();
  }

  /**
   * 表示用に現在の設定を一括取得する。
   *
   * model / effort の source:
   *   - thread:  スレッド固有値が KV にある
   *   - channel: 親チャンネル値が KV にある (thread には無い)
   *   - default: defaults にある (thread / channel どちらも無い)
   *   - undefined: defaults にも無い
   *
   * session は thread と channel で独立。threadId 指定時は thread の値、
   * 未指定時は channel の値を返す。
   */
  async getScopeSettings(scope: StoreScope): Promise<ScopeSettings> {
    const channelKeys = [
      [NS, scope.channelId, SESSION],
      [NS, scope.channelId, MODEL],
      [NS, scope.channelId, EFFORT],
    ] as const;

    if (scope.threadId === undefined) {
      const [sessionEntry, modelEntry, effortEntry] = await this.kv.getMany<
        [string, string, string]
      >([...channelKeys]);
      return {
        session: sessionEntry.value ?? undefined,
        model: resolveSetting(
          null,
          modelEntry.value,
          this.defaults.model,
        ),
        effort: resolveSetting(
          null,
          effortEntry.value,
          this.defaults.effort,
        ),
      };
    }

    const threadKeys = [
      [NS, scope.threadId, SESSION],
      [NS, scope.threadId, MODEL],
      [NS, scope.threadId, EFFORT],
    ] as const;
    const [
      threadSession,
      threadModel,
      threadEffort,
      _channelSession,
      channelModel,
      channelEffort,
    ] = await this.kv.getMany<
      [string, string, string, string, string, string]
    >([...threadKeys, ...channelKeys]);

    return {
      // session は thread のみ参照、channel にはフォールバックしない
      session: threadSession.value ?? undefined,
      model: resolveSetting(
        threadModel.value,
        channelModel.value,
        this.defaults.model,
      ),
      effort: resolveSetting(
        threadEffort.value,
        channelEffort.value,
        this.defaults.effort,
      ),
    };
  }

  /**
   * Deno KV をクローズする。プロセス終了前に呼ぶ。
   */
  close(): void {
    this.kv.close();
  }
}

function resolveSetting(
  threadValue: string | null,
  channelValue: string | null,
  defaultValue: string | undefined,
): ScopeSettingEntry | undefined {
  if (threadValue !== null) {
    return { value: threadValue, source: "thread" };
  }
  if (channelValue !== null) {
    return { value: channelValue, source: "channel" };
  }
  if (defaultValue !== undefined) {
    return { value: defaultValue, source: "default" };
  }
  return undefined;
}
