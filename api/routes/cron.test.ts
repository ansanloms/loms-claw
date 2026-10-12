import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { createCronRoutes } from "./cron.ts";

describe("createCronRoutes", () => {
  test("POST /reload: reloadCronJobs が成功した場合に ok: true を返すこと", async () => {
    let called = false;
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        reloadCronJobs: () => {
          called = true;
          return Promise.resolve();
        },
      }),
    );

    const res = await app.request("/cron/reload", { method: "POST" });

    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true });
    assert.deepStrictEqual(called, true);
  });

  test("POST /reload: reloadCronJobs が未指定の場合に 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/cron", createCronRoutes());

    const res = await app.request("/cron/reload", { method: "POST" });

    assert.deepStrictEqual(res.status, 503);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "cron reload not available");
  });

  test("POST /reload: reloadCronJobs が例外を投げた場合に 500 を返すこと", async () => {
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        reloadCronJobs: () => Promise.reject(new Error("load failed")),
      }),
    );
    app.onError((err, c) => {
      return c.json({ error: err.message }, 500);
    });

    const res = await app.request("/cron/reload", { method: "POST" });

    assert.deepStrictEqual(res.status, 500);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "load failed");
  });

  test("GET /: ジョブ一覧が返ること", async () => {
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        listJobs: () => [
          {
            kind: "prompt",
            name: "job1",
            schedule: "0 9 * * *",
            prompt: "test",
            channelId: "123",
            once: false,
          },
          {
            kind: "command",
            name: "job2",
            schedule: "0 18 * * *",
            command: "echo hello",
            once: true,
          },
        ],
      }),
    );

    const res = await app.request("/cron");
    assert.deepStrictEqual(res.status, 200);
    const json = (await res.json()) as {
      jobs: Array<{
        name: string;
        kind: string;
        channelId?: string;
        once: boolean;
      }>;
    };
    assert.deepStrictEqual(json.jobs.length, 2);
    assert.deepStrictEqual(json.jobs[0].name, "job1");
    assert.deepStrictEqual(json.jobs[0].kind, "prompt");
    assert.deepStrictEqual(json.jobs[0].channelId, "123");
    assert.deepStrictEqual(json.jobs[0].once, false);
    assert.deepStrictEqual(json.jobs[1].name, "job2");
    assert.deepStrictEqual(json.jobs[1].kind, "command");
    assert.deepStrictEqual(json.jobs[1].channelId, undefined);
    assert.deepStrictEqual(json.jobs[1].once, true);
  });

  test("GET /: listJobs 未指定で 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/cron", createCronRoutes());

    const res = await app.request("/cron");
    assert.deepStrictEqual(res.status, 503);
  });

  test("POST /run: 正常にジョブが実行されること", async () => {
    const executed: string[] = [];
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        runJob: (name: string) => {
          executed.push(name);
          return Promise.resolve();
        },
      }),
    );

    const res = await app.request("/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "my-job" }),
    });

    assert.deepStrictEqual(res.status, 200);
    assert.deepStrictEqual(await res.json(), { ok: true, name: "my-job" });
    assert.deepStrictEqual(executed, ["my-job"]);
  });

  test("POST /run: name 未指定で 400 を返すこと", async () => {
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        runJob: async () => {},
      }),
    );

    const res = await app.request("/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(
      json.error,
      'Instance does not have required property "name".',
    );
  });

  test("POST /run: 存在しないジョブで 404 を返すこと", async () => {
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        runJob: () => {
          return Promise.reject(new Error("job not found: nonexistent"));
        },
      }),
    );

    const res = await app.request("/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "nonexistent" }),
    });

    assert.deepStrictEqual(res.status, 404);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "job not found: nonexistent");
  });

  test("POST /run: runJob 未指定で 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/cron", createCronRoutes());

    const res = await app.request("/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });

    assert.deepStrictEqual(res.status, 503);
  });

  test("POST /run: 不正な JSON ボディで 400 を返すこと", async () => {
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        runJob: () => Promise.resolve(),
      }),
    );

    const res = await app.request("/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });

    assert.deepStrictEqual(res.status, 400);
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepStrictEqual(json.error, "invalid JSON body");
  });
});
