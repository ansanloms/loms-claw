import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createLogger } from "../../logger.ts";
import { createLogsRoutes } from "./logs.ts";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/logs", createLogsRoutes());
  return app;
}

describe("createLogsRoutes", () => {
  test("GET /: limit=0 は 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=0");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "limit must be a positive integer");
  });

  test("GET /: limit=1 は 200 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1");
    assert.deepStrictEqual(res.status, 200);
  });

  test("GET /: limit=1000 は 200 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1000");
    assert.deepStrictEqual(res.status, 200);
  });

  test("GET /: limit=1001 は 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1001");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "limit must not exceed 1000");
  });

  test("GET /: limit が非整数の場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=abc");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "limit must be a positive integer");
  });

  test("GET /: limit が空文字の場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "limit must be a positive integer");
  });

  test("GET /: limit が指数表記 (1e3) の場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=1e3");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "limit must be a positive integer");
  });

  test("GET /: limit が 16 進表記 (0x3e8) の場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?limit=0x3e8");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "limit must be a positive integer");
  });

  test("GET /: level が不正な場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?level=TRACE");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(
      json.error,
      "invalid level: TRACE. valid: DEBUG, INFO, WARN, ERROR",
    );
  });

  test("GET /: since が不正な場合に 400 を返すこと", async () => {
    const app = buildApp();
    const res = await app.request("/logs?since=not-a-date");
    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "invalid since: must be ISO 8601");
  });

  test("GET /: namespace と limit で絞り込んだ LogEntry の配列が返ること", async () => {
    const namespace = "logs-test-body";
    const log = createLogger(namespace);
    for (let i = 0; i < 5; i++) {
      log.info(`entry ${i}`);
    }

    const app = buildApp();
    const res = await app.request(`/logs?namespace=${namespace}&limit=3`);
    assert.deepStrictEqual(res.status, 200);
    const json = (await res.json()) as Array<Record<string, unknown>>;
    assert.deepStrictEqual(Array.isArray(json), true);
    assert.deepStrictEqual(json.length, 3);
    for (const entry of json) {
      assert.ok(
        typeof entry === "object" && entry !== null,
        `expected object, got ${JSON.stringify(entry)}`,
      );
      assert.deepStrictEqual(typeof entry.timestamp, "string");
      assert.deepStrictEqual(typeof entry.level, "string");
      assert.deepStrictEqual(entry.namespace, namespace);
      assert.deepStrictEqual(typeof entry.message, "string");
    }
  });
});
