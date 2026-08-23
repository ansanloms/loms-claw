/**
 * アプリケーション設定のロード。
 *
 * `config.json` を読み込み、@cfworker/json-schema で JSON Schema 検証を掛けた後、
 * プロセス固有の値（`claude.cwd`）を注入して {@link Config} を返す。
 *
 * パスは `LOMS_CLAW_CONFIG` 環境変数で上書き可能（デフォルト: `./data/config.json`）。
 */

import type { LogLevel } from "./logger.ts";
import {
  applyConfigDefaults,
  formatConfigErrors,
  validateConfigFile,
} from "./config.schema.ts";
import { getErrorMessage } from "./errors.ts";

/**
 * Claude のグローバルデフォルト。チャンネル単位の上書きが無いときに使われる。
 */
export interface ClaudeDefaults {
  /** デフォルトのモデル alias または full name。 */
  model?: string;
  /** デフォルトの effort level (low / medium / high / xhigh / max)。 */
  effort?: string;
  /** thinking（推論）を Discord に表示するか。省略時は false 扱い。 */
  showThinking?: boolean;
}

/**
 * Claude 呼び出し (Agent SDK `query()`) 設定。
 */
export interface ClaudeConfig {
  /** `query()` の `maxTurns` に渡す最大ターン数。 */
  maxTurns: number;
  /** 現在未使用。後方互換のため保持。 */
  verbose: boolean;
  /** Claude 呼び出しのタイムアウト（ミリ秒）。`query()` の abort に使う。 */
  timeout: number;
  /** 内部 API サーバーのポート（cron + ログ）。 */
  apiPort: number;
  /** `query()` の作業ディレクトリ。実行時に `Deno.cwd()` が注入される。 */
  cwd: string;
  /** Claude のグローバルデフォルト (model / effort)。 */
  defaults: ClaudeDefaults;
}

/**
 * ロガー設定。
 */
export interface LogConfig {
  /** 出力する最低ログレベル。 */
  level: LogLevel;
  /** メモリ上のリングバッファ容量。 */
  bufferSize: number;
}

/**
 * Discord 接続・認可関連の設定。
 */
export interface DiscordConfig {
  /** Discord bot トークン。 */
  token: string;
  /** 対象 Discord ギルド ID。 */
  guildId: string;
  /** 操作を許可する唯一のユーザー ID。 */
  userId: string;
  /** mention 不要で全メッセージに反応するチャンネル ID の配列。 */
  activeChannelIds: string[];
}

/**
 * バリデーション済みのアプリケーション設定。
 */
export interface Config {
  /** Discord 接続・認可関連の設定。 */
  discord: DiscordConfig;
  /** 永続化ストア (Deno KV / SQLite) のファイルパス。 */
  storePath: string;
  /** Claude 呼び出し (Agent SDK query()) 設定。 */
  claude: ClaudeConfig;
  /** ロガー設定。 */
  log: LogConfig;
}

/**
 * 設定ファイル（JSON）に書き込む shape。`claude.cwd` はプロセス由来なので
 * JSON の `claude` からは取得せず、{@link loadConfig} が実行時に注入する。
 */
export interface ConfigFile extends Omit<Config, "claude"> {
  claude: Omit<ClaudeConfig, "cwd">;
}

/**
 * 設定ファイルを読み込み、バリデーション後に `claude.cwd` を注入して返す。
 *
 * `LOMS_CLAW_CONFIG` 環境変数で任意のパスを指定できる（未指定なら `./data/config.json`）。
 *
 * @throws ファイルが存在しない、JSON パースに失敗、スキーマ検証に失敗した場合。
 */
export function loadConfig(): Config {
  const path = Deno.env.get("LOMS_CLAW_CONFIG") ?? "./data/config.json";

  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    const msg = getErrorMessage(e);
    throw new Error(`failed to read config file (${path}): ${msg}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = getErrorMessage(e);
    throw new Error(`failed to parse config file (${path}): ${msg}`);
  }

  // ajv の useDefaults 相当: 検証前に schema の default を補完する（破壊的変更）。
  applyConfigDefaults(raw);

  const { valid, errors } = validateConfigFile(raw);
  if (!valid) {
    const details = formatConfigErrors(errors);
    throw new Error(`config validation failed (${path}):\n${details}`);
  }

  // $schema は IDE / tooling 用のメタデータなので、実行時 Config からは除外する。
  const { $schema: _ignored, ...rest } = raw as ConfigFile & {
    $schema?: string;
  };
  return {
    ...rest,
    claude: {
      ...rest.claude,
      cwd: Deno.cwd(),
    },
  };
}
