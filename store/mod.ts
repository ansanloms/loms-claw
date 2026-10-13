/**
 * チャンネル / スレッド単位の永続化ストア。
 *
 * SQLite (`node:sqlite`) に session_id / model / effort / showThinking を保存する。
 *
 * スコープは {channelId, threadId?} の組で表す。
 *   - threadId 無し: 通常チャンネル (= スレッドではないテキストチャンネル) または
 *     cron の擬似 channelId (`cron:{name}`) など。
 *   - threadId あり: スレッド。フォールバック先として親チャンネルを参照する。
 *
 * model / effort / showThinking は thread → channel → defaults の順に解決する。
 * session は thread と channel で完全に独立し、互いにフォールバックしない。
 * active は thread → channel の順に解決するが、defaults を持たない (未設定なら
 * undefined を返し、呼び出し側で config.json の activeChannelIds による判定へ
 * フォールバックする)。
 *
 * テーブル設計:
 *   settings(id, field, value) 主キー (id, field)。
 *   field は "session" | "model" | "effort" | "showThinking" | "active"、
 *   value は文字列。
 *   id は Discord Snowflake (channel / thread どちらも) または `cron:{name}`。
 *   thread と channel は同一 Snowflake 名前空間で衝突しないため、id をそのまま
 *   行の識別に使い分ける。
 *
 * @module
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { isRecord } from "../guards.ts";

const SESSION = "session";
const MODEL = "model";
const EFFORT = "effort";
const SHOW_THINKING = "showThinking";
const ACTIVE = "active";

/**
 * `resolveScoped()` が読み取り対象にできるストアのフィールド。
 * thread → channel → (defaults) の解決チェーンを持つフィールドに限る
 * (`session` はこのチェーンを持たないため含めない)。
 */
type StoreField =
  | typeof MODEL
  | typeof EFFORT
  | typeof SHOW_THINKING
  | typeof ACTIVE;

/**
 * グローバルデフォルト値。チャンネル / スレッド単位の上書きが無いときに使われる。
 */
export interface StoreDefaults {
  model?: string;
  effort?: string;
  showThinking?: boolean;
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
 * boolean 設定値とその出所を表すエントリ。
 */
export interface BoolScopeSettingEntry {
  value: boolean;
  source: SettingSource;
}

/**
 * スコープ単位の設定スナップショット。
 */
export interface ScopeSettings {
  session?: string;
  model?: ScopeSettingEntry;
  effort?: ScopeSettingEntry;
  /** showThinking は未設定でも false (source: default) として常に解決する。 */
  showThinking: BoolScopeSettingEntry;
  /**
   * active は上書きが無ければ undefined。config の activeChannelIds による
   * 判定へフォールバックすることを意味する (showThinking と異なり defaults を持たない)。
   */
  active?: BoolScopeSettingEntry;
}

/**
 * 設定の部分更新。JSON Merge Patch (RFC 7386) の意味論に従う。
 *   - キーを省略した場合: その設定を変更しない
 *   - null を指定した場合: その設定を削除し、フォールバックへ戻す
 *
 * session は削除のみ受け付ける。任意のセッション ID の書き込みを許可すると
 * 他スコープの会話を乗っ取れるため。
 */
export interface SettingsPatch {
  model?: string | null;
  effort?: string | null;
  showThinking?: boolean | null;
  active?: boolean | null;
  session?: null;
}

/**
 * ストア用の SQLite DB を開く。
 *
 * `timeout` は他プロセスがロックを持つ間の待ち時間 (ミリ秒)。
 * 並行アクセスに備えて WAL モードにする (`:memory:` では WAL にならないが害は無い)。
 */
export function openStoreDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { timeout: 5000 });
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/**
 * `settings` の value 列を取り出す。Store が書く値は常に string なので、
 * 形が合わなければストアの破損として throw する。
 */
function toValue(row: unknown): string {
  if (!isRecord(row) || typeof row.value !== "string") {
    throw new Error("store: unexpected row shape for settings.value");
  }
  return row.value;
}

/**
 * `settings` の (id, field, value) 行を取り出す。
 */
function toSettingRow(row: unknown): {
  id: string;
  field: string;
  value: string;
} {
  if (
    !isRecord(row) ||
    typeof row.id !== "string" ||
    typeof row.field !== "string" ||
    typeof row.value !== "string"
  ) {
    throw new Error("store: unexpected row shape for settings");
  }
  return { id: row.id, field: row.field, value: row.value };
}

/**
 * SQLite (`node:sqlite`) ベースのスコープ設定ストア。
 */
export class Store {
  private readonly db: DatabaseSync;
  private readonly defaults: StoreDefaults;
  private readonly selectValue: StatementSync;
  private readonly upsertValue: StatementSync;
  private readonly deleteField: StatementSync;
  private readonly deleteAll: StatementSync;
  private readonly selectChannel: StatementSync;
  private readonly selectChannelAndThread: StatementSync;

  constructor(db: DatabaseSync, defaults: StoreDefaults = {}) {
    this.db = db;
    this.defaults = defaults;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS settings (
        id TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (id, field)
      )`,
    );
    this.selectValue = this.db.prepare(
      "SELECT value FROM settings WHERE id = $id AND field = $field",
    );
    this.upsertValue = this.db.prepare(
      `INSERT INTO settings (id, field, value) VALUES ($id, $field, $value)
       ON CONFLICT(id, field) DO UPDATE SET value = excluded.value`,
    );
    this.deleteField = this.db.prepare(
      "DELETE FROM settings WHERE id = $id AND field = $field",
    );
    this.deleteAll = this.db.prepare("DELETE FROM settings WHERE id = $id");
    this.selectChannel = this.db.prepare(
      "SELECT id, field, value FROM settings WHERE id = $channelId",
    );
    this.selectChannelAndThread = this.db.prepare(
      "SELECT id, field, value FROM settings WHERE id IN ($channelId, $threadId)",
    );
  }

  private readValue(id: string, field: string): string | null {
    const row = this.selectValue.get({ id, field });
    return row === undefined ? null : toValue(row);
  }

  private writeValue(id: string, field: string, value: string): void {
    this.upsertValue.run({ id, field, value });
  }

  private deleteValue(id: string, field: string): void {
    this.deleteField.run({ id, field });
  }

  private deleteScope(id: string): void {
    this.deleteAll.run({ id });
  }

  // ── session ─────────────────────────────────────────────
  // session は thread と channel で独立。フォールバックしない。

  async getSession(scope: StoreScope): Promise<string | undefined> {
    const id = scope.threadId ?? scope.channelId;
    return this.readValue(id, SESSION) ?? undefined;
  }

  async setSession(scope: StoreScope, sessionId: string): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    this.writeValue(id, SESSION, sessionId);
  }

  // ── thread → channel → (defaults) の共通解決ヘルパ ─────────
  // model / effort / showThinking / active の読み取りはすべて
  // 「thread になければ channel、channel にもなければ fallback」という同じ形を
  // とる。fallback の有無・boolean 変換の要否だけがフィールドごとに異なるため、
  // それを parse / fallback 引数に切り出す。

  private async resolveScoped<T>(
    scope: StoreScope,
    field: StoreField,
    parse: (raw: string) => T,
    fallback: T | undefined,
  ): Promise<T | undefined> {
    if (scope.threadId !== undefined) {
      const threadValue = this.readValue(scope.threadId, field);
      if (threadValue !== null) {
        return parse(threadValue);
      }
    }
    const channelValue = this.readValue(scope.channelId, field);
    if (channelValue !== null) {
      return parse(channelValue);
    }
    return fallback;
  }

  // ── model ───────────────────────────────────────────────
  // thread → channel → defaults の順で解決。

  async getModel(scope: StoreScope): Promise<string | undefined> {
    return await this.resolveScoped(
      scope,
      MODEL,
      (raw) => raw,
      this.defaults.model,
    );
  }

  // ── effort ──────────────────────────────────────────────

  async getEffort(scope: StoreScope): Promise<string | undefined> {
    return await this.resolveScoped(
      scope,
      EFFORT,
      (raw) => raw,
      this.defaults.effort,
    );
  }

  // ── showThinking ────────────────────────────────────────
  // thread → channel → defaults の順で解決。boolean は ストアに "true" / "false"
  // の文字列で格納する (値を文字列で統一するため)。未設定なら false。

  async getShowThinking(scope: StoreScope): Promise<boolean> {
    const value = await this.resolveScoped(
      scope,
      SHOW_THINKING,
      (raw) => raw === "true",
      this.defaults.showThinking,
    );
    return value ?? false;
  }

  // ── active ──────────────────────────────────────────────
  // thread → channel の順で解決。showThinking と異なり defaults を持たず、
  // どちらにも無ければ undefined を返す (呼び出し側で config の
  // activeChannelIds による判定へフォールバックする)。false を明示できることが
  // この設定の要点なので、未設定と false を混同しないこと。

  async getActive(scope: StoreScope): Promise<boolean | undefined> {
    return await this.resolveScoped(
      scope,
      ACTIVE,
      (raw) => raw === "true",
      undefined,
    );
  }

  // ── まとめ操作 ─────────────────────────────────────────

  /**
   * 指定スコープの session / model / effort を全削除する。
   * threadId 指定時は thread の設定のみ消し、親チャンネルの設定は残す。
   * threadId 未指定時はチャンネルの設定のみ消す (配下のスレッド設定は残る)。
   *
   * `DELETE ... WHERE id` 1 文で消すため、複数の行が中途半端に残る状態にならない。
   */
  async clearScope(scope: StoreScope): Promise<void> {
    const id = scope.threadId ?? scope.channelId;
    this.deleteScope(id);
  }

  /**
   * 指定スコープへ部分更新を適用する。
   *
   * 書き込み先の id は setSession() と同じく `scope.threadId ?? scope.channelId`。
   * patch のキーのうち値が undefined でないものだけを処理し、null なら削除、
   * それ以外なら設定する。複数キーの更新は 1 トランザクションにまとめ、
   * 中途半端に一部だけ適用された状態を防ぐ。
   *
   * 返す解決結果は渡された scope に基づく。threadId を含まない scope を渡せば
   * thread のフォールバックは効かない (getScopeSettings() と同じ)。
   */
  async applyPatch(
    scope: StoreScope,
    patch: SettingsPatch,
  ): Promise<ScopeSettings> {
    const id = scope.threadId ?? scope.channelId;

    const writes: [string, string | boolean | null | undefined][] = [
      [MODEL, patch.model],
      [EFFORT, patch.effort],
      [SHOW_THINKING, patch.showThinking],
      [ACTIVE, patch.active],
    ];
    // session は null (削除) のみ許可される (SettingsPatch 型で保証)。
    const deleteSession = patch.session !== undefined;

    if (writes.some(([, value]) => value !== undefined) || deleteSession) {
      this.db.exec("BEGIN");
      try {
        for (const [field, value] of writes) {
          if (value === undefined) {
            continue;
          }
          if (value === null) {
            this.deleteValue(id, field);
          } else {
            this.writeValue(id, field, String(value));
          }
        }
        if (deleteSession) {
          this.deleteValue(id, SESSION);
        }
        this.db.exec("COMMIT");
      } catch (e) {
        if (this.db.isTransaction) {
          this.db.exec("ROLLBACK");
        }
        throw e;
      }
    }

    return await this.getScopeSettings(scope);
  }

  /**
   * 表示用に現在の設定を一括取得する。
   *
   * model / effort の source:
   *   - thread:  スレッド固有値がストアにある
   *   - channel: 親チャンネル値がストアにある (thread には無い)
   *   - default: defaults にある (thread / channel どちらも無い)
   *   - undefined: defaults にも無い
   *
   * session は thread と channel で独立。threadId 指定時は thread の値、
   * 未指定時は channel の値を返す。
   */
  async getScopeSettings(scope: StoreScope): Promise<ScopeSettings> {
    const channelId = scope.channelId;
    const threadId = scope.threadId;

    // thread / channel の行を 1 回の SELECT でまとめて読む。
    const rows = new Map<string, Map<string, string>>();
    const found =
      threadId === undefined
        ? this.selectChannel.all({ channelId })
        : this.selectChannelAndThread.all({ channelId, threadId });
    for (const raw of found) {
      const row = toSettingRow(raw);
      let fields = rows.get(row.id);
      if (fields === undefined) {
        fields = new Map();
        rows.set(row.id, fields);
      }
      fields.set(row.field, row.value);
    }
    const read = (id: string, field: string): string | null =>
      rows.get(id)?.get(field) ?? null;

    if (threadId === undefined) {
      return {
        session: read(channelId, SESSION) ?? undefined,
        model: resolveSetting(
          null,
          read(channelId, MODEL),
          this.defaults.model,
        ),
        effort: resolveSetting(
          null,
          read(channelId, EFFORT),
          this.defaults.effort,
        ),
        showThinking: resolveBoolSetting(
          null,
          read(channelId, SHOW_THINKING),
          this.defaults.showThinking,
        ),
        active: resolveOptionalBoolSetting(null, read(channelId, ACTIVE)),
      };
    }

    return {
      // session は thread のみ参照、channel にはフォールバックしない
      session: read(threadId, SESSION) ?? undefined,
      model: resolveSetting(
        read(threadId, MODEL),
        read(channelId, MODEL),
        this.defaults.model,
      ),
      effort: resolveSetting(
        read(threadId, EFFORT),
        read(channelId, EFFORT),
        this.defaults.effort,
      ),
      active: resolveOptionalBoolSetting(
        read(threadId, ACTIVE),
        read(channelId, ACTIVE),
      ),
      showThinking: resolveBoolSetting(
        read(threadId, SHOW_THINKING),
        read(channelId, SHOW_THINKING),
        this.defaults.showThinking,
      ),
    };
  }

  /**
   * グローバルデフォルト値のコピーを返す。
   * 呼び出し側から内部状態を書き換えられないよう、参照ではなくコピーを返す。
   */
  getDefaults(): StoreDefaults {
    return { ...this.defaults };
  }

  /**
   * DB をクローズする。プロセス終了前に呼ぶ。
   */
  close(): void {
    this.db.close();
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

/**
 * boolean 設定値を thread → channel → default の順で解決する。
 *
 * ストアには "true" / "false" の文字列で格納されている。model / effort と違い、
 * boolean は「未設定 = false」という確定した既定値があるため、どこにも値が
 * 無いときも `{ value: false, source: "default" }` を返す (undefined にしない)。
 */
function resolveBoolSetting(
  threadValue: string | null,
  channelValue: string | null,
  defaultValue: boolean | undefined,
): BoolScopeSettingEntry {
  if (threadValue !== null) {
    return { value: threadValue === "true", source: "thread" };
  }
  if (channelValue !== null) {
    return { value: channelValue === "true", source: "channel" };
  }
  return { value: defaultValue ?? false, source: "default" };
}

/**
 * boolean 設定値を thread → channel の順で解決する。resolveBoolSetting() と
 * 異なり defaults へのフォールバックを持たないため、どちらにも値が無ければ
 * undefined を返す (false にしない。未設定と false を区別するのが active の要点)。
 */
function resolveOptionalBoolSetting(
  threadValue: string | null,
  channelValue: string | null,
): BoolScopeSettingEntry | undefined {
  if (threadValue !== null) {
    return { value: threadValue === "true", source: "thread" };
  }
  if (channelValue !== null) {
    return { value: channelValue === "true", source: "channel" };
  }
  return undefined;
}
