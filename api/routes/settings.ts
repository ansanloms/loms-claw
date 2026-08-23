/**
 * settings ルート。
 *
 * チャンネル / スレッド単位の設定 (model / effort / showThinking / active / session) の
 * 取得・部分更新・全削除と、グローバルデフォルトの取得を HTTP エンドポイントとして提供する。
 *
 * `{id}` がスレッドか通常チャンネルかはサーバ側 (resolveScope()) が判定してスコープを
 * 組み立てる。呼び出し側は対象の ID を渡すだけでよく、親子関係を意識する必要はない。
 * ただしスコープへの書き込み / 削除は Store の仕様どおり leaf id (`threadId ?? channelId`)
 * 単位で行われるため、スレッド解決の有無に関わらず PATCH / DELETE の挙動そのものは変わらない
 * (差が出るのは GET / PATCH の応答となる解決結果だけ)。
 */

import { Hono } from "hono";
import type { FromSchema } from "json-schema-to-ts";
import type { Store, StoreScope } from "../../store/mod.ts";
import { internalSchemas } from "../internal-schemas.ts";
import { matchesSchema, schemaErrorOf } from "../validate.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("api-settings");

/**
 * settings ルートに注入する依存関係。
 */
export interface SettingsRouteContext {
  /** スコープ設定ストア。 */
  store: Store;
  /**
   * 指定 ID がスレッドならその親チャンネル ID を、そうでなければ null を返す。
   * 未注入・解決失敗時はチャンネル扱いにフォールバックする。
   */
  resolveParentId?: (id: string) => Promise<string | null>;
}

/** request body が RequestPatchSettings スキーマに適合するかの型ガード。 */
function isPatchSettingsBody(
  value: unknown,
): value is FromSchema<typeof internalSchemas["RequestPatchSettings"]> {
  return matchesSchema("RequestPatchSettings", value);
}

/**
 * 指定 ID から StoreScope を解決する。
 *
 * `ctx.resolveParentId` が未注入ならチャンネル単独スコープを返す。注入されている
 * 場合は呼び出し、親チャンネル ID が返れば thread スコープ、null ならチャンネル
 * 単独スコープを返す。`resolveParentId` が throw した場合 (未知の ID や cron の
 * 擬似 id 等) は握りつぶし、チャンネル単独スコープへフォールバックする。
 */
async function resolveScope(
  ctx: SettingsRouteContext,
  id: string,
): Promise<StoreScope> {
  if (!ctx.resolveParentId) {
    return { channelId: id };
  }
  try {
    const parentId = await ctx.resolveParentId(id);
    return parentId ? { channelId: parentId, threadId: id } : {
      channelId: id,
    };
  } catch (e) {
    // cron:{name} は cron ジョブの擬似 ID で、resolveParentId (discord.js のチャンネル
    // 解決) は設計上必ず失敗するため、想定内の失敗として debug に留める。それ以外の ID
    // (Discord のチャンネル/スレッド ID のはず) での失敗は想定外なので warn で記録する。
    if (id.startsWith("cron:")) {
      log.debug(
        `resolveParentId failed for ${id}, falling back to channel:`,
        e,
      );
    } else {
      log.warn(
        `resolveParentId failed for ${id}, falling back to channel scope (親チャンネルの解決に失敗したためチャンネル単独スコープとして扱う):`,
        e,
      );
    }
    return { channelId: id };
  }
}

/**
 * settings ルートを生成する。
 *
 * @param ctx - 依存関係コンテキスト。
 */
export function createSettingsRoutes(ctx: SettingsRouteContext) {
  const app = new Hono();

  // /:id より先に登録する (登録順に依存しないルータもあるが、依存する構成でも壊れないようにする)。
  app.get("/default", (c) => {
    const defaults = ctx.store.getDefaults();
    return c.json({
      model: defaults.model,
      effort: defaults.effort,
      showThinking: defaults.showThinking ?? false,
    });
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const scope = await resolveScope(ctx, id);
    const settings = await ctx.store.getScopeSettings(scope);
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

    const scope = await resolveScope(ctx, id);
    log.debug(`patch settings for ${id}:`, JSON.stringify(body));
    const settings = await ctx.store.applyPatch(scope, body);
    return c.json(settings);
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const scope = await resolveScope(ctx, id);
    log.debug(`clear settings for ${id}`);
    await ctx.store.clearScope(scope);
    return c.json({ ok: true });
  });

  return app;
}
