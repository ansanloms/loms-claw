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
import { createLogsRoutes } from "./routes/logs.ts";
import {
  createSettingsRoutes,
  type SettingsRouteContext,
} from "./routes/settings.ts";
import { createLogger } from "../logger.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("api-server");

/**
 * 統合 HTTP サーバーを起動する。
 *
 * @param port - リッスンポート。
 * @param settingsCtx - settings ルートの依存関係コンテキスト。
 * @param cronCtx - cron ルートの依存関係コンテキスト。
 * @returns Deno.HttpServer インスタンス（shutdown() で停止可能）。
 */
export function startApiServer(
  port: number,
  settingsCtx: SettingsRouteContext,
  cronCtx?: CronRouteContext,
): Deno.HttpServer {
  const app = new Hono();

  // リクエストログ
  app.use(async (c, next) => {
    log.debug(`${c.req.method} ${c.req.path}`);
    await next();
  });

  // サブルートをマウント
  app.route("/cron", createCronRoutes(cronCtx));
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

  const server = Deno.serve(
    { port, hostname: "127.0.0.1" },
    app.fetch,
  );

  log.info("API server started on port", port);
  return server;
}
