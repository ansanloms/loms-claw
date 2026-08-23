/**
 * エントリポイント — 設定ファイルを読み込み、ボットを起動する。
 *
 * @module
 */

import { dirname } from "@std/path/dirname";
import { createLogger, initLogger } from "./logger.ts";
import { loadConfig } from "./config.ts";
import { DiscordBot } from "./bot/mod.ts";
import { Store } from "./store/mod.ts";

const log = createLogger("main");

// グローバルな未ハンドル例外をキャッチしてプロセスの即死を防ぐ。
globalThis.addEventListener("unhandledrejection", (e) => {
  log.error("unhandled rejection:", e.reason);
  e.preventDefault();
});

globalThis.addEventListener("error", (e) => {
  log.error("uncaught exception:", e.error ?? e.message);
  e.preventDefault();
});

const config = loadConfig();
initLogger(config.log);

// 永続化ストア (Deno KV / SQLite) を初期化する。
// 親ディレクトリが存在しない可能性があるため事前に mkdir。
// kv は起動リトライの外側で 1 度だけ open する。open / close の所有は
// main.ts に寄せ、close() はシグナルハンドラが bot.shutdown() の後に呼ぶ。
// mkdir / Deno.openKv はいずれもリトライしても回復しないため、失敗はここで
// 即座にログを出して終了する (起動リトライの対象にしない)。
let kv: Deno.Kv;
let storeDirReady = false;
try {
  await Deno.mkdir(dirname(config.storePath), { recursive: true });
  storeDirReady = true;
  kv = await Deno.openKv(config.storePath);
} catch (e: unknown) {
  if (!storeDirReady) {
    log.error(`failed to prepare store directory: ${config.storePath}:`, e);
  } else {
    log.error(`failed to open store: ${config.storePath}:`, e);
  }
  Deno.exit(1);
}
const store = new Store(kv, config.claude.defaults);
log.info(`store opened: ${config.storePath}`);

/**
 * 現在稼働中のボットインスタンス。シグナルハンドラから参照する。
 */
let bot: DiscordBot | null = null;

// bot が null（起動リトライ中）でも store.close() は行う。
// 2 回目のシグナルで強制終了する。
let shuttingDown = false;
const onSignal = () => {
  if (shuttingDown) {
    Deno.exit(1);
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
      Deno.exit(failed ? 1 : 0);
    }
  })();
};
Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);

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
    if (attempt === MAX_RETRIES) {
      log.error("max retries reached, exiting");
      Deno.exit(1);
    }
    const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
    log.info(`retrying in ${delay / 1000}s...`);
    await new Promise((r) => setTimeout(r, delay));
  }
}
