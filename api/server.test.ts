import { assertEquals } from "@std/assert";
import { createApp } from "./server.ts";
import { Store, type StoreDefaults } from "../store/mod.ts";

const defaults: StoreDefaults = {};

/** createApp() のための最小 settingsCtx / healthCtx を用意して実行する。 */
async function withApp(
  fn: (app: ReturnType<typeof createApp>) => Promise<void>,
  cronCtx?: Parameters<typeof createApp>[2],
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new Store(kv, defaults);
    const app = createApp(
      { store },
      { isReady: () => true },
      cronCtx,
    );
    await fn(app);
  } finally {
    kv.close();
  }
}

Deno.test("createApp", async (t) => {
  await t.step(
    '未定義パスへのアクセスは 404 で { error: "Not Found" } を返すこと',
    async () => {
      await withApp(async (app) => {
        const res = await app.request("/no-such-route");
        assertEquals(res.status, 404);
        assertEquals(await res.json(), { error: "Not Found" });
      });
    },
  );

  await t.step(
    "マウント済みルートで例外が投げられた場合に 500 で { error: message } を返すこと",
    async () => {
      await withApp(
        async (app) => {
          const res = await app.request("/cron/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: "job-1" }),
          });
          assertEquals(res.status, 500);
          assertEquals(await res.json(), { error: "boom" });
        },
        {
          runJob: () => Promise.reject(new Error("boom")),
        },
      );
    },
  );

  await t.step("/health がマウントされていること", async () => {
    await withApp(async (app) => {
      const res = await app.request("/health");
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { status: "ok" });
    });
  });

  await t.step("/logs がマウントされていること", async () => {
    await withApp(async (app) => {
      const res = await app.request("/logs");
      assertEquals(res.status, 200);
    });
  });

  await t.step("/settings がマウントされていること", async () => {
    await withApp(async (app) => {
      const res = await app.request("/settings/default");
      assertEquals(res.status, 200);
    });
  });

  await t.step(
    "/cron は cronCtx 未指定でも 503 を返しマウント自体はされていること",
    async () => {
      await withApp(async (app) => {
        const res = await app.request("/cron");
        assertEquals(res.status, 503);
      });
    },
  );
});
