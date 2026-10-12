import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createHealthRoutes } from "./health.ts";

describe("health routes", () => {
  test("GET /: isReady が true の場合に 200 で status: ok を返すこと", async () => {
    const app = new Hono();
    app.route("/health", createHealthRoutes({ isReady: () => true }));

    const res = await app.request("/health");

    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { status: "ok" });
  });

  test("GET /: isReady が false の場合に 503 で status: unavailable を返すこと", async () => {
    const app = new Hono();
    app.route("/health", createHealthRoutes({ isReady: () => false }));

    const res = await app.request("/health");

    assert.deepStrictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), { status: "unavailable" });
  });
});
