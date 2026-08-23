/**
 * 統合 HTTP サーバー。
 *
 * cron ジョブの一覧取得・手動実行・再読み込み、ログ取得、スコープ設定の
 * 取得・部分更新・削除を Hono アプリケーションとして単一の Deno.serve() で提供する。
 *
 * ツール承認は SDK の `canUseTool` コールバックで in-process に処理するため、
 * HTTP エンドポイントは持たない。
 */

import { Hono } from "hono";
import { createCronRoutes, type CronRouteContext } from "./routes/cron.ts";
import {
  createHealthRoutes,
  type HealthRouteContext,
} from "./routes/health.ts";
import { createLogsRoutes } from "./routes/logs.ts";
import {
  createSettingsRoutes,
  type SettingsRouteContext,
} from "./routes/settings.ts";
import { createLogger } from "../logger.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("api-server");

/**
 * 統合 HTTP サーバーの Hono アプリケーションを組み立てる。
 *
 * `startApiServer()` から Hono アプリの組み立てだけを切り出したもの。
 * `Deno.serve()` を経由せずに `app.request()` で直接叩けるため、
 * ルーティング (404 / 500 / マウント) を単体テストできる。
 *
 * @param settingsCtx - settings ルートの依存関係コンテキスト。
 * @param healthCtx - health ルートの依存関係コンテキスト。
 * @param cronCtx - cron ルートの依存関係コンテキスト。
 * @returns 組み立て済みの Hono アプリケーション。
 */
export function createApp(
  settingsCtx: SettingsRouteContext,
  healthCtx: HealthRouteContext,
  cronCtx?: CronRouteContext,
): Hono {
  const app = new Hono();

  // リクエストログ。
  // /health は compose.yaml の healthcheck から 60 秒ごとに probe されるため、
  // ここでログに出すとリングバッファ (logger.ts。level に関わらず全件保持) が
  // 実際のログをすぐ押し出してしまう。probe は除外する。
  app.use(async (c, next) => {
    if (c.req.path !== "/health") {
      log.debug(`${c.req.method} ${c.req.path}`);
    }
    await next();
  });

  // サブルートをマウント
  app.route("/cron", createCronRoutes(cronCtx));
  app.route("/health", createHealthRoutes(healthCtx));
  app.route("/logs", createLogsRoutes());
  app.route("/settings", createSettingsRoutes(settingsCtx));

  // 未定義パスへのアクセス
  app.notFound((c) => c.json({ error: "Not Found" }, 404));

  // 共通エラーハンドラ
  app.onError((err, c) => {
    const msg = getErrorMessage(err);
    log.error(`${c.req.method} ${c.req.path} error:`, msg);
    return c.json({ error: msg }, 500);
  });

  return app;
}

/**
 * 統合 HTTP サーバーを起動する。
 *
 * @param port - リッスンポート。
 * @param settingsCtx - settings ルートの依存関係コンテキスト。
 * @param healthCtx - health ルートの依存関係コンテキスト。
 * @param cronCtx - cron ルートの依存関係コンテキスト。
 * @returns Deno.HttpServer インスタンス（shutdown() で停止可能）。
 */
export function startApiServer(
  port: number,
  settingsCtx: SettingsRouteContext,
  healthCtx: HealthRouteContext,
  cronCtx?: CronRouteContext,
): Deno.HttpServer {
  const app = createApp(settingsCtx, healthCtx, cronCtx);

  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    app.fetch,
  );

  log.info("API server started on port", port);
  return server;
}
