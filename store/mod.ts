/**
 * チャンネル単位の永続化ストア。
 *
 * Deno KV (SQLite backend) に session_id / model / effort を保存する。
 * model / effort は KV の値を優先し、無ければコンストラクタで受け取った
 * グローバルデフォルトにフォールバックする。session にデフォルトはない。
 *
 * cron ジョブは `cron:<jobName>` を擬似 channelId として同じスキームに乗る。
 *
 * @module
 */

const NS = "channel";
const SESSION = "session";
const MODEL = "model";
const EFFORT = "effort";

/**
 * グローバルデフォルト値。チャンネル単位の上書きが無いときに使われる。
 */
export interface StoreDefaults {
  model?: string;
  effort?: string;
}

/**
 * チャンネルの設定値とその出所を表すエントリ。
 */
export interface ChannelSettingEntry {
  value: string;
  source: "channel" | "default";
}

/**
 * チャンネル単位の設定スナップショット。
 */
export interface ChannelSettings {
  session?: string;
  model?: ChannelSettingEntry;
  effort?: ChannelSettingEntry;
}

/**
 * Deno KV ベースのチャンネル設定ストア。
 *
 * キー設計:
 *   ["channel", channelId, "session" | "model" | "effort"] -> string
 */
export class Store {
  constructor(
    private readonly kv: Deno.Kv,
    private readonly defaults: StoreDefaults = {},
  ) {}

  // ── session ─────────────────────────────────────────────

  async getSession(channelId: string): Promise<string | undefined> {
    const entry = await this.kv.get<string>([NS, channelId, SESSION]);
    return entry.value ?? undefined;
  }

  async setSession(channelId: string, sessionId: string): Promise<void> {
    await this.kv.set([NS, channelId, SESSION], sessionId);
  }

  async deleteSession(channelId: string): Promise<void> {
    await this.kv.delete([NS, channelId, SESSION]);
  }

  // ── model ───────────────────────────────────────────────

  async getModel(channelId: string): Promise<string | undefined> {
    const entry = await this.kv.get<string>([NS, channelId, MODEL]);
    return entry.value ?? this.defaults.model;
  }

  async setModel(channelId: string, model: string): Promise<void> {
    await this.kv.set([NS, channelId, MODEL], model);
  }

  async deleteModel(channelId: string): Promise<void> {
    await this.kv.delete([NS, channelId, MODEL]);
  }

  // ── effort ──────────────────────────────────────────────

  async getEffort(channelId: string): Promise<string | undefined> {
    const entry = await this.kv.get<string>([NS, channelId, EFFORT]);
    return entry.value ?? this.defaults.effort;
  }

  async setEffort(channelId: string, effort: string): Promise<void> {
    await this.kv.set([NS, channelId, EFFORT], effort);
  }

  async deleteEffort(channelId: string): Promise<void> {
    await this.kv.delete([NS, channelId, EFFORT]);
  }

  // ── まとめ操作 ─────────────────────────────────────────

  /**
   * 指定チャンネルの session / model / effort を全削除する。
   * デフォルトは消えないため、削除後も getModel / getEffort は defaults を返す。
   *
   * delete を atomic で 1 コミットにまとめる。`kv.list` 自体は atomic では
   * ないが、取得済みキーの削除を 1 トランザクションに集約することで「複数
   * キーが中途半端に残る」状態を防ぐ。
   */
  async clearChannel(channelId: string): Promise<void> {
    const atomic = this.kv.atomic();
    for await (const entry of this.kv.list({ prefix: [NS, channelId] })) {
      atomic.delete(entry.key);
    }
    await atomic.commit();
  }

  /**
   * 表示用に現在の設定を一括取得する。
   * model / effort は KV にあれば source: "channel"、defaults にあれば "default"、
   * いずれも無ければ undefined。
   */
  async getChannelSettings(channelId: string): Promise<ChannelSettings> {
    const [sessionEntry, modelEntry, effortEntry] = await this.kv.getMany<
      [string, string, string]
    >([
      [NS, channelId, SESSION],
      [NS, channelId, MODEL],
      [NS, channelId, EFFORT],
    ]);

    return {
      session: sessionEntry.value ?? undefined,
      model: resolveSetting(modelEntry.value, this.defaults.model),
      effort: resolveSetting(effortEntry.value, this.defaults.effort),
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
  channelValue: string | null,
  defaultValue: string | undefined,
): ChannelSettingEntry | undefined {
  if (channelValue !== null) {
    return { value: channelValue, source: "channel" };
  }
  if (defaultValue !== undefined) {
    return { value: defaultValue, source: "default" };
  }
  return undefined;
}
