/**
 * 統合 HTTP サーバー。
 *
 * 承認フック（PreToolUse）、cron リロード、Discord REST API を
 * Hono アプリケーションとして単一の Deno.serve() で提供する。
 */

import { Hono } from "hono";
import type { ApprovalManager } from "../approval/manager.ts";
import type { ApiContext } from "./types.ts";
import { createApprovalRoutes } from "./routes/approval.ts";
import { createCronRoutes } from "./routes/cron.ts";
import { createDiscordRoutes } from "./routes/discord.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("api-server");

/**
 * 統合 HTTP サーバーを起動する。
 *
 * @param manager - 承認マネージャー。
 * @param discordCtx - Discord API コンテキスト。
 * @param port - リッスンポート。
 * @param reloadCronJobs - cron ジョブ再読み込み関数。
 * @returns Deno.HttpServer インスタンス（shutdown() で停止可能）。
 */
export function startApiServer(
  manager: ApprovalManager,
  discordCtx: ApiContext,
  port: number,
  reloadCronJobs?: () => Promise<void>,
): Deno.HttpServer {
  const app = new Hono();

  // リクエストログ
  app.use(async (c, next) => {
    log.debug(`${c.req.method} ${c.req.path}`);
    await next();
  });

  // サブルートをマウント
  app.route("/approval", createApprovalRoutes(manager));
  app.route("/cron", createCronRoutes(reloadCronJobs));
  app.route("/discord", createDiscordRoutes(discordCtx));

  // 共通エラーハンドラ
  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
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
