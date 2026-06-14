/**
 * cron ルート。
 *
 * cron ジョブの一覧取得・手動実行・定義の再読み込みを HTTP エンドポイントとして提供する。
 */

import { Hono } from "hono";
import type { FromSchema } from "json-schema-to-ts";
import type { CronJobDef } from "../../cron/types.ts";
import { internalSchemas } from "../internal-schemas.ts";
import { matchesSchema, schemaErrorOf } from "../validate.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-cron");

/**
 * cron ルートに注入する依存関係。
 */
export interface CronRouteContext {
  /** cron ジョブ定義を再読み込みする。 */
  reloadCronJobs?: () => Promise<void>;
  /** 名前を指定してジョブを手動実行する。ジョブが見つからない場合は Error を throw する。 */
  runJob?: (name: string) => Promise<void>;
  /** 登録済みジョブ一覧を返す。 */
  listJobs?: () => CronJobDef[];
}

/** request body が RequestPostCronRun スキーマに適合するかの型ガード。 */
function isCronRunBody(
  value: unknown,
): value is FromSchema<typeof internalSchemas["RequestPostCronRun"]> {
  return matchesSchema("RequestPostCronRun", value);
}

/**
 * cron ルートを生成する。
 *
 * @param ctx - 依存関係コンテキスト。
 */
export function createCronRoutes(ctx: CronRouteContext = {}) {
  const app = new Hono();

  app.get("/", (c) => {
    if (!ctx.listJobs) {
      return c.json({ error: "cron not available" }, 503);
    }
    const jobs = ctx.listJobs().map((j) => ({
      name: j.name,
      schedule: j.schedule,
      channelId: j.channelId,
      once: j.once,
    }));
    return c.json({ jobs });
  });

  app.post("/run", async (c) => {
    if (!ctx.runJob) {
      return c.json({ error: "cron not available" }, 503);
    }
    const body = await c.req.json();
    if (!isCronRunBody(body)) {
      return c.json({ error: schemaErrorOf("RequestPostCronRun", body) }, 400);
    }
    const { name } = body;
    try {
      log.debug(`manual run: ${name}`);
      await ctx.runJob(name);
      return c.json({ ok: true, name });
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("job not found:")) {
        return c.json({ error: e.message }, 404);
      }
      throw e;
    }
  });

  app.post("/reload", async (c) => {
    if (!ctx.reloadCronJobs) {
      return c.json({ error: "cron reload not available" }, 503);
    }
    log.debug("reloading cron jobs");
    await ctx.reloadCronJobs();
    return c.json({ ok: true });
  });

  return app;
}
