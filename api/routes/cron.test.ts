import { assertEquals } from "@std/assert";
import { createCronRoutes } from "./cron.ts";
import { Hono } from "hono";

Deno.test("createCronRoutes", async (t) => {
  await t.step(
    "reloadCronJobs が成功した場合に ok: true を返すこと",
    async () => {
      let called = false;
      const reload = () => {
        called = true;
        return Promise.resolve();
      };
      const app = new Hono();
      app.route("/cron", createCronRoutes(reload));

      const res = await app.request("/cron/reload", { method: "POST" });

      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true });
      assertEquals(called, true);
    },
  );

  await t.step("reloadCronJobs が未指定の場合に 503 を返すこと", async () => {
    const app = new Hono();
    app.route("/cron", createCronRoutes());

    const res = await app.request("/cron/reload", { method: "POST" });

    assertEquals(res.status, 503);
    const json = await res.json();
    assertEquals(json.error, "cron reload not available");
  });

  await t.step(
    "reloadCronJobs が例外を投げた場合に 500 を返すこと",
    async () => {
      const reload = () => Promise.reject(new Error("load failed"));
      const app = new Hono();
      app.route("/cron", createCronRoutes(reload));
      app.onError((err, c) => {
        return c.json({ error: err.message }, 500);
      });

      const res = await app.request("/cron/reload", { method: "POST" });

      assertEquals(res.status, 500);
      const json = await res.json();
      assertEquals(json.error, "load failed");
    },
  );
});
