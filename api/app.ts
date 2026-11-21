import { Hono } from "hono";
import type { ResponseBody } from "./openapi.ts";

export function createApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const body: ResponseBody<"getHealth", 200> = { status: "ok" };
    return c.json(body, 200);
  });

  return app;
}
