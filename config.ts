/**
 * アプリケーション設定のロード。
 *
 * `config.json` を読み込み、ajv で JSON Schema 検証を掛けた後、
 * プロセス固有の値（`claude.cwd`）を注入して {@link Config} を返す。
 *
 * パスは `LOMS_CLAW_CONFIG` 環境変数で上書き可能（デフォルト: `./config.json`）。
 */

import type { LogLevel } from "./logger.ts";
import { formatConfigErrors, validateConfigFile } from "./config.schema.ts";

/**
 * Claude Code CLI 設定。
 */
export interface ClaudeConfig {
  /** `--max-turns` に渡す最大ターン数。 */
  maxTurns: number;
  /** `--verbose` フラグ。 */
  verbose: boolean;
  /** プロセスタイムアウト（ミリ秒）。 */
  timeout: number;
  /** 内部 API サーバーのポート（承認 + Discord API）。 */
  apiPort: number;
  /** `claude` プロセスの作業ディレクトリ。実行時に `Deno.cwd()` が注入される。 */
  cwd: string;
}

/**
 * ボイスチャンネル関連の設定。
 */
export interface VoiceConfig {
  /** VC 機能の有効/無効。 */
  enabled: boolean;
  /** whisper.cpp サーバーの URL。 */
  whisperUrl: string;
  /** TTS サーバーの URL（OpenAI 互換）。 */
  ttsUrl: string;
  /** TTS API キー。 */
  ttsApiKey?: string;
  /** TTS モデル名。 */
  ttsModel: string;
  /** TTS スピーカー/音声 ID。 */
  ttsSpeaker: string;
  /** TTS 再生速度。 */
  ttsSpeed: number;
  /** STT に送る最小発話時間（ミリ秒）。 */
  minSpeechMs: number;
  /** 発話とみなす最小 RMS 振幅。 */
  speechRms: number;
  /** AI 再生を中断する最小 RMS 振幅。 */
  interruptRms: number;
  /** 無人 VC からの自動退出タイムアウト（ミリ秒）。-1 で無効。 */
  autoLeaveMs: number;
  /** 発話デバウンス待機時間（ミリ秒）。 */
  speechDebounceMs: number;
  /** no_speech_prob 閾値。全セグメントがこの値以上なら無音と判定。 */
  noSpeechProbThreshold: number;
  /** 通知トーン（処理中・エラー）の有効/無効。 */
  notificationTone: boolean;
  /** auto-join: false=無効, true=全VC, string[]=指定VC IDのみ。 */
  autoJoinVc: false | true | string[];
}

/**
 * Claude のグローバルデフォルト。チャンネル単位の上書きが無いときに使われる。
 */
export interface ClaudeDefaults {
  /** デフォルトのモデル alias または full name。 */
  model?: string;
  /** デフォルトの effort level (low / medium / high / xhigh / max)。 */
  effort?: string;
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
 * バリデーション済みのアプリケーション設定。
 */
export interface Config {
  /** Discord bot トークン。 */
  discordToken: string;
  /** 対象 Discord ギルド ID。 */
  guildId: string;
  /** 操作を許可する唯一のユーザー ID。 */
  authorizedUserId: string;
  /** mention 不要で全メッセージに反応するチャンネル ID の配列。 */
  activeChannelIds: string[];
  /** 永続化ストア (Deno KV / SQLite) のファイルパス。 */
  storePath: string;
  /** Claude のグローバルデフォルト (model / effort)。 */
  defaults: ClaudeDefaults;
  /** Claude Code CLI 設定。 */
  claude: ClaudeConfig;
  /** ボイスチャンネル設定。 */
  voice: VoiceConfig;
  /** ロガー設定。 */
  log: LogConfig;
}

/**
 * 設定ファイル（JSON）に書き込む shape。`claude.cwd` はプロセス由来なので
 * JSON からは取得せず、{@link loadConfig} が実行時に注入する。
 */
export interface ConfigFile extends Omit<Config, "claude"> {
  claude: Omit<ClaudeConfig, "cwd">;
}

/**
 * 設定ファイルを読み込み、バリデーション後に `claude.cwd` を注入して返す。
 *
 * `LOMS_CLAW_CONFIG` 環境変数で任意のパスを指定できる（未指定なら `./config.json`）。
 *
 * @throws ファイルが存在しない、JSON パースに失敗、スキーマ検証に失敗した場合。
 */
export function loadConfig(): Config {
  const path = Deno.env.get("LOMS_CLAW_CONFIG") ?? "./config.json";

  let text: string;
  try {
    text = Deno.readTextFileSync(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to read config file (${path}): ${msg}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to parse config file (${path}): ${msg}`);
  }

  if (!validateConfigFile(raw)) {
    const details = formatConfigErrors(validateConfigFile.errors);
    throw new Error(`config validation failed (${path}):\n${details}`);
  }

  return {
    ...raw,
    claude: { ...raw.claude, cwd: Deno.cwd() },
  };
}
