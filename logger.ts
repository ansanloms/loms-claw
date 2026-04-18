/**
 * 名前空間付きの軽量構造化ロガー。
 *
 * ログレベルは環境変数 LOG_LEVEL で制御する（デフォルト: INFO）。
 * 有効な値: DEBUG | INFO | WARN | ERROR（大文字小文字不問）。
 *
 * 直近のログをメモリ上のリングバッファに保持し、
 * {@link getLogEntries} で取得できる。バッファサイズは LOG_BUFFER_SIZE で制御する（デフォルト: 1000）。
 *
 * @example
 * ```ts
 * const log = createLogger("claude");
 * log.info("プロセス起動");
 * log.error("API エラー:", status, body);
 * ```
 */

/**
 * サポートするログレベル（重要度の昇順）。
 */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_ORDER: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

// ---------------------------------------------------------------------------
// リングバッファ
// ---------------------------------------------------------------------------

/**
 * メモリ上に保持するログエントリ。
 */
export interface LogEntry {
  /** ISO 8601 タイムスタンプ。 */
  timestamp: string;
  /** ログレベル。 */
  level: LogLevel;
  /** ロガーの名前空間。 */
  namespace: string;
  /** メッセージ本文（引数を含む文字列化済み）。 */
  message: string;
}

/**
 * {@link getLogEntries} のフィルタ条件。
 */
export interface LogFilter {
  /** この重要度以上のエントリのみ返す。 */
  level?: LogLevel;
  /** 名前空間の前方一致フィルタ。 */
  namespace?: string;
  /** この ISO タイムスタンプ以降のエントリのみ返す。 */
  since?: string;
  /** 最大取得件数（デフォルト 100、最大 1000）。 */
  limit?: number;
}

/** バッファ容量。環境変数で上書き可能。 */
const BUFFER_CAPACITY = (() => {
  try {
    const v = Number(Deno.env.get("LOG_BUFFER_SIZE"));
    if (Number.isFinite(v) && v > 0) {
      return Math.min(v, 10000);
    }
  } catch { /* ignore */ }
  return 1000;
})();

/** リングバッファ本体。 */
const buffer: (LogEntry | undefined)[] = new Array(BUFFER_CAPACITY);
/** 次に書き込む位置。 */
let writePos = 0;
/** バッファに書き込まれた総数（容量を超えても加算し続ける）。 */
let totalWritten = 0;

/**
 * エントリをリングバッファに追加する。
 */
function pushEntry(entry: LogEntry): void {
  buffer[writePos] = entry;
  writePos = (writePos + 1) % BUFFER_CAPACITY;
  totalWritten++;
}

/**
 * リングバッファから条件に合うログエントリを時系列順で返す。
 */
export function getLogEntries(filter?: LogFilter): LogEntry[] {
  const minLevel = filter?.level ? LEVEL_ORDER[filter.level] : 0;
  const ns = filter?.namespace;
  const since = filter?.since;
  const limit = Math.min(Math.max(filter?.limit ?? 100, 1), 1000);

  // 時系列順に走査するための開始位置を決定
  const count = Math.min(totalWritten, BUFFER_CAPACITY);
  const start = totalWritten <= BUFFER_CAPACITY ? 0 : writePos; // writePos が最古のエントリを指す

  const result: LogEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = buffer[(start + i) % BUFFER_CAPACITY];
    if (!entry) {
      continue;
    }
    if (LEVEL_ORDER[entry.level] < minLevel) {
      continue;
    }
    if (ns && !entry.namespace.startsWith(ns)) {
      continue;
    }
    if (since && entry.timestamp < since) {
      continue;
    }
    result.push(entry);
  }

  // 末尾から limit 件を返す（最新のものを優先）
  return result.slice(-limit);
}

/**
 * 環境変数から LOG_LEVEL を読み取る。未設定・無効値の場合は INFO を返す。
 */
function getMinLevel(): LogLevel {
  try {
    const env = Deno.env.get("LOG_LEVEL")?.toUpperCase();
    if (env && env in LEVEL_ORDER) {
      return env as LogLevel;
    }
  } catch {
    // --allow-env が付与されていない場合はデフォルトに落ちる
  }
  return "INFO";
}

const minLevel = getMinLevel();

/**
 * createLogger が返すロガーインターフェース。
 */
export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

/**
 * 指定した名前空間に紐づくロガーを生成する。
 * 各ログ行には ISO タイムスタンプ、レベル、名前空間プレフィクスが付く。
 *
 * DEBUG/INFO は stdout、WARN/ERROR は stderr に出力する。
 *
 * @param namespace - サブシステムの短い識別子（例: "bot", "claude"）。
 */
export function createLogger(namespace: string): Logger {
  function emit(level: LogLevel, msg: string, args: unknown[]): void {
    const ts = Temporal.Now.instant().toString();

    // リングバッファには minLevel に関係なく全レベルを記録する
    const fullMessage = args.length > 0
      ? `${msg} ${args.map(stringifyArg).join(" ")}`
      : msg;
    pushEntry({ timestamp: ts, level, namespace, message: fullMessage });

    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) {
      return;
    }
    const prefix = `${ts} [${level.padEnd(5)}] [${namespace}]`;
    if (level === "ERROR") {
      console.error(prefix, msg, ...args);
    } else if (level === "WARN") {
      console.warn(prefix, msg, ...args);
    } else {
      console.log(prefix, msg, ...args);
    }
  }

  return {
    debug: (msg, ...args) => emit("DEBUG", msg, args),
    info: (msg, ...args) => emit("INFO", msg, args),
    warn: (msg, ...args) => emit("WARN", msg, args),
    error: (msg, ...args) => emit("ERROR", msg, args),
  };
}

/**
 * ログ引数を文字列化する。
 *
 * Error オブジェクトは `JSON.stringify` だと `{}` になり情報が落ちるため、
 * stack (あれば) または message を抽出する。
 */
function stringifyArg(a: unknown): string {
  if (typeof a === "string") {
    return a;
  }
  if (a instanceof Error) {
    return a.stack ?? `${a.name}: ${a.message}`;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}
