import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createLogsRoutes } from "./logs.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/logs", createLogsRoutes());
  return app;
}

Deno.test("createLogsRoutes", async (t) => {
  await t.step("GET /: limit=0 は 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=0");
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "limit must be a positive integer");
  });

  await t.step("GET /: limit=1 は 200 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1");
    assertEquals(res.status, 200);
  });

  await t.step("GET /: limit=1000 は 200 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1000");
    assertEquals(res.status, 200);
  });

  await t.step("GET /: limit=1001 は 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1001");
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "limit must not exceed 1000");
  });

  await t.step("GET /: limit が非整数の場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=abc");
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "limit must be a positive integer");
  });

  await t.step("GET /: level が不正な場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?level=TRACE");
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(
      json.error,
      "invalid level: TRACE. valid: DEBUG, INFO, WARN, ERROR",
    );
  });

  await t.step("GET /: since が不正な場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?since=not-a-date");
    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "invalid since: must be ISO 8601");
  });
});
