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
  /** healthy かどうかを判定する。Discord Gateway の接続状態等を返す。 */
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
