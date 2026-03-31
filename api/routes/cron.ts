/**
 * cron リロードルート。
 *
 * cron ジョブ定義の再読み込みを HTTP エンドポイントとして提供する。
 */

import { Hono } from "hono";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-cron");

/**
 * cron リロードルートを生成する。
 *
 * @param reloadCronJobs - cron ジョブ再読み込み関数。未指定時は 503 を返す。
 */
export function createCronRoutes(reloadCronJobs?: () => Promise<void>) {
  const app = new Hono();

  app.post("/reload", async (c) => {
    if (!reloadCronJobs) {
      return c.json({ error: "cron reload not available" }, 503);
    }
    log.debug("reloading cron jobs");
    await reloadCronJobs();
    return c.json({ ok: true });
  });

  return app;
}
