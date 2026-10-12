/**
 * エントリポイント — 設定ファイルを読み込み、ボットを起動する。
 *
 * @module
 */

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path/dirname";
import { DiscordBot } from "./bot/mod.ts";
import { loadConfig } from "./config.ts";
import { createLogger, initLogger } from "./logger.ts";
import { openStoreDatabase, Store } from "./store/mod.ts";

const log = createLogger("main");

// グローバルな未ハンドル例外をキャッチしてプロセスの即死を防ぐ。
process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
  log.error("uncaught exception:", err);
});

const config = loadConfig();
initLogger(config.log);

// 永続化ストア (SQLite) を初期化する。
// 親ディレクトリが存在しない可能性があるため事前に mkdir。
// db は起動リトライの外側で 1 度だけ open する。open / close の所有は
// main.ts に寄せ、close() はシグナルハンドラが bot.shutdown() の後に呼ぶ。
// mkdir / openStoreDatabase / new Store はいずれもリトライしても回復しないため、失敗はここで
// 即座にログを出して終了する (起動リトライの対象にしない)。
let db: DatabaseSync;
let store: Store;
let storeDirReady = false;
try {
  await mkdir(dirname(config.storePath), { recursive: true });
  storeDirReady = true;
  db = openStoreDatabase(config.storePath);
  // 旧 Deno KV ファイル等を黙って開かないよう、Store のガードも同じ try で受ける。
  store = new Store(db, config.claude.defaults);
} catch (e: unknown) {
  if (!storeDirReady) {
    log.error(`failed to prepare store directory: ${config.storePath}:`, e);
  } else {
    log.error(`failed to open store: ${config.storePath}:`, e);
  }
  process.exit(1);
}
log.info(`store opened: ${config.storePath}`);

// 移行漏れの検知: 新ストアが空で、同じディレクトリに旧既定名の Deno KV ファイルが
// あれば警告する (起動は止めない)。
if (store.isEmpty() && extname(config.storePath) === ".sqlite") {
  const legacyPath = join(dirname(config.storePath), "loms-claw.kv");
  if (existsSync(legacyPath)) {
    log.warn(
      `旧 Deno KV ファイルが見つかった: ${legacyPath}。データ移行は docs/architecture/deployment.md の移行節を参照`,
    );
  }
}

/**
 * 現在稼働中のボットインスタンス。シグナルハンドラから参照する。
 */
let bot: DiscordBot | null = null;

// bot が null（起動リトライ中）でも store.close() は行う。
// 2 回目のシグナルで強制終了する。
let shuttingDown = false;
const onSignal = () => {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  (async () => {
    let failed = false;
    try {
      await bot?.shutdown();
    } catch (e) {
      failed = true;
      log.error("bot shutdown failed:", e);
    } finally {
      try {
        store.close();
      } catch (e) {
        failed = true;
        log.error("store close failed:", e);
      }
      process.exit(failed ? 1 : 0);
    }
  })();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);

/**
 * 起動リトライの最大回数。
 */
const MAX_RETRIES = 5;
/**
 * リトライ間隔の初期値（ミリ秒）。指数バックオフで増加する。
 */
const BASE_DELAY_MS = 3_000;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  if (shuttingDown) {
    break;
  }
  try {
    bot = new DiscordBot(config, store);
    await bot.start();
    break;
  } catch (e: unknown) {
    log.error(`start failed (attempt ${attempt}/${MAX_RETRIES}):`, e);
    // 失敗した試行の bot は client / cron / API サーバーが部分的に生きている
    // ことがあるため、次の試行(新しい bot)の前に畳む。重複応答・重複実行を防ぐ。
    try {
      await bot?.shutdown();
    } catch (cleanupError: unknown) {
      log.warn("cleanup after failed start:", cleanupError);
    }
    if (attempt === MAX_RETRIES) {
      log.error("max retries reached, exiting");
      process.exit(1);
    }
    const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
    log.info(`retrying in ${delay / 1000}s...`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
