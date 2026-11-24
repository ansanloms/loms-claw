import { Hono } from "hono";
import type { components } from "./openapi.gen.d.ts";
import { handleError } from "./openapi.ts";

export function createApp(): Hono {
  const app = new Hono();
  app.onError(handleError);

  // API 定義 (docs/api) に載せない運用用の口。compose の healthcheck が使う。
  app.get("/health", (c) => c.json({ status: "ok" }, 200));

  app.notFound((c) => {
    const body: components["schemas"]["ResponseError"] = { error: "Not Found" };
    return c.json(body, 404);
  });

  return app;
}
