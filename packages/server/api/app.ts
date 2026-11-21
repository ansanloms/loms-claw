import { Hono } from "hono";
import type { components } from "./openapi.gen.d.ts";
import { handleError } from "./openapi.ts";
import type { ResponseBody } from "./openapi.ts";

export function createApp(): Hono {
  const app = new Hono();
  app.onError(handleError);

  app.get("/health", (c) => {
    const body: ResponseBody<"getHealth", 200> = { status: "ok" };
    return c.json(body, 200);
  });

  app.notFound((c) => {
    const body: components["schemas"]["ResponseError"] = { error: "Not Found" };
    return c.json(body, 404);
  });

  return app;
}
