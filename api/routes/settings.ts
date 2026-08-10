/**
 * settings ルート。
 *
 * チャンネル / スレッド単位の設定 (model / effort / showThinking / active / session) の
 * 取得・部分更新・全削除と、グローバルデフォルトの取得を HTTP エンドポイントとして提供する。
 */

import { Hono } from "hono";
import type { FromSchema } from "json-schema-to-ts";
import type { Store, StoreScope } from "../../store/mod.ts";
import { internalSchemas } from "../internal-schemas.ts";
import { matchesSchema, schemaErrorOf } from "../validate.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-settings");

/** request body が RequestPatchSettings スキーマに適合するかの型ガード。 */
function isPatchSettingsBody(
  value: unknown,
): value is FromSchema<typeof internalSchemas["RequestPatchSettings"]> {
  return matchesSchema("RequestPatchSettings", value);
}

/**
 * settings ルートを生成する。
 *
 * @param store - スコープ設定ストア。
 */
export function createSettingsRoutes(store: Store) {
  const app = new Hono();

  // /:id より先に登録する (登録順に依存しないルータもあるが、依存する構成でも壊れないようにする)。
  app.get("/default", (c) => {
    const defaults = store.getDefaults();
    return c.json({
      model: defaults.model,
      effort: defaults.effort,
      showThinking: defaults.showThinking ?? false,
    });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    // `?parentId=` のように空文字が来た場合は未指定として扱う。空の channelId で
    // スコープを組むと、存在しないチャンネルへフォールバックする壊れた解決になるため。
    const parentId = c.req.query("parentId");
    const scope: StoreScope = parentId
      ? { channelId: parentId, threadId: id }
      : { channelId: id };
    const settings = await store.getScopeSettings(scope);
    return c.json(settings);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }

    if (!isPatchSettingsBody(body)) {
      return c.json(
        { error: schemaErrorOf("RequestPatchSettings", body) },
        400,
      );
    }

    const scope: StoreScope = { channelId: id };
    log.debug(`patch settings for ${id}:`, JSON.stringify(body));
    const settings = await store.applyPatch(scope, body);
    return c.json(settings);
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const scope: StoreScope = { channelId: id };
    log.debug(`clear settings for ${id}`);
    await store.clearScope(scope);
    return c.json({ ok: true });
  });

  return app;
}
