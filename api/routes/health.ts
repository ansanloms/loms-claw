/**
 * health ルート。
 *
 * HTTP サーバ自体の応答性だけでなく Discord Gateway の接続状態を反映した
 * healthcheck 用エンドポイントを提供する。compose.yaml の healthcheck から
 * 定期的に叩かれる想定 (docs/architecture/deployment.md 参照)。
 */

import { Hono } from "hono";

/**
 * health ルートに注入する依存関係。
 */
export interface HealthRouteContext {
  /**
   * healthy かどうかを判定する。
   *
   * `bot/mod.ts` は Discord Gateway の全シャードの status が Ready のときのみ
   * true を返す (discord.js の `Client#isReady()` は一度 Ready になった後の
   * 切断を検知できないため使わない)。
   */
  isReady: () => boolean;
}

/**
 * health ルートを生成する。
 *
 * @param ctx - 依存関係コンテキスト。
 */
export function createHealthRoutes(ctx: HealthRouteContext) {
  const app = new Hono();

  app.get("/", (c) => {
    if (!ctx.isReady()) {
      return c.json({ status: "unavailable" }, 503);
    }
    return c.json({ status: "ok" });
  });

  return app;
}
