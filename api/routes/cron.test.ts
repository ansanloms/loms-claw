import { assertEquals } from "@std/assert";
import { createCronRoutes } from "./cron.ts";
import { Hono } from "hono";

Deno.test("createCronRoutes", async (t) => {
  await t.step(
    "POST /reload: reloadCronJobs が成功した場合に ok: true を返すこと",
    async () => {
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

      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });
      assertEquals(called, true);
    },
  );

  await t.step(
    "POST /reload: reloadCronJobs が未指定の場合に 503 を返すこと",
    async () => {
      const app = new Hono();
      app.route("/cron", createCronRoutes());

      const res = await app.request("/cron/reload", { method: "POST" });

      assertEquals(res.status, 503);
      const json = await res.json();
      assertEquals(json.error, "cron reload not available");
    },
  );

  await t.step(
    "POST /reload: reloadCronJobs が例外を投げた場合に 500 を返すこと",
    async () => {
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

      assertEquals(res.status, 500);
      const json = await res.json();
      assertEquals(json.error, "load failed");
    },
  );

  await t.step("GET /: ジョブ一覧が返ること", async () => {
    const app = new Hono();
    app.route(
      "/cron",
      createCronRoutes({
        listJobs: () => [
          {
            name: "job1",
            schedule: "0 9 * * *",
            prompt: "test",
            channelId: "123",
            once: false,
          },
          {
            name: "job2",
            schedule: "0 18 * * *",
            prompt: "test2",
            once: true,
          },
        ],
      }),
    );

    const res = await app.request("/cron");
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.jobs.length, 2);
    assertEquals(json.jobs[0].name, "job1");
    assertEquals(json.jobs[0].channelId, "123");
    assertEquals(json.jobs[0].once, false);
    assertEquals(json.jobs[1].name, "job2");
    assertEquals(json.jobs[1].channelId, undefined);
    assertEquals(json.jobs[1].once, true);
  });

  await t.step("GET /: listJobs 未指定で 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/cron", createCronRoutes());

    const res = await app.request("/cron");
    assertEquals(res.status, 503);
  });

  await t.step("POST /run: 正常にジョブが実行されること", async () => {
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

    assertEquals(res.status, 200);
    assertEquals(await res.json(), { ok: true, name: "my-job" });
    assertEquals(executed, ["my-job"]);
  });

  await t.step("POST /run: name 未指定で 400 を返すこと", async () => {
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

    assertEquals(res.status, 400);
    const json = await res.json();
    assertEquals(json.error, "name is required");
  });

  await t.step(
    "POST /run: 存在しないジョブで 404 を返すこと",
    async () => {
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

      assertEquals(res.status, 404);
      const json = await res.json();
      assertEquals(json.error, "job not found: nonexistent");
    },
  );

  await t.step("POST /run: runJob 未指定で 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/cron", createCronRoutes());

    const res = await app.request("/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test" }),
    });

    assertEquals(res.status, 503);
  });
});
