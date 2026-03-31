/**
 * エントリポイント — 環境変数を読み込み、ボットを起動する。
 *
 * @module
 */

import "@std/dotenv/load";

import { createLogger } from "./logger.ts";
import { loadConfig } from "./config.ts";
import { DiscordBot } from "./bot/mod.ts";

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

/**
 * 現在稼働中のボットインスタンス。シグナルハンドラから参照する。
 */
let bot: DiscordBot | null = null;

// bot が null（起動リトライ中）の場合、shutdown() は no-op となりリトライが継続する。
// 2 回目のシグナルで強制終了する。
let shuttingDown = false;
const onSignal = () => {
  if (shuttingDown) {
    Deno.exit(1);
  }
  shuttingDown = true;
  bot?.shutdown();
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
  try {
    bot = new DiscordBot(config);
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
