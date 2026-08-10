import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { createSettingsRoutes } from "./settings.ts";
import { Store, type StoreDefaults } from "../../store/mod.ts";

async function withApp(
  defaults: StoreDefaults,
  fn: (app: Hono) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new Store(kv, defaults);
    const app = new Hono();
    app.route("/settings", createSettingsRoutes(store));
    await fn(app);
  } finally {
    kv.close();
  }
}

/** エラー応答が ResponseError スキーマ相当の形をしていることを検証する。 */
function assertErrorBody(body: unknown): void {
  assert(
    typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "string" && body.error.length > 0,
    `expected { error: string }, got ${JSON.stringify(body)}`,
  );
}

Deno.test("createSettingsRoutes", async (t) => {
  await t.step(
    "GET /settings/default: defaults が返ること",
    async () => {
      await withApp({ model: "sonnet", effort: "medium" }, async (app) => {
        const res = await app.request("/settings/default");
        assertEquals(res.status, 200);
        assertEquals(await res.json(), {
          model: "sonnet",
          effort: "medium",
          showThinking: false,
        });
      });
    },
  );

  await t.step(
    "GET /settings/default: showThinking が未設定でも false で返ること",
    async () => {
      await withApp({}, async (app) => {
        const res = await app.request("/settings/default");
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.showThinking, false);
        assertEquals(json.model, undefined);
        assertEquals(json.effort, undefined);
      });
    },
  );

  await t.step(
    "GET /settings/:id: 未設定のスコープでもデフォルト解決の結果が返ること",
    async () => {
      await withApp({ model: "sonnet" }, async (app) => {
        const res = await app.request("/settings/ch-1");
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.model, { value: "sonnet", source: "default" });
        assertEquals(json.showThinking, { value: false, source: "default" });
      });
    },
  );

  await t.step(
    "GET /settings/:id?parentId=...: thread → channel のフォールバックが効くこと",
    async () => {
      await withApp({}, async (app) => {
        const patchRes = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });
        assertEquals(patchRes.status, 200);

        const res = await app.request(
          "/settings/th-1?parentId=ch-1",
        );
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.model, { value: "opus", source: "channel" });
      });
    },
  );

  await t.step(
    "GET /settings/:id?parentId=: parentId が空文字なら未指定として扱うこと",
    async () => {
      await withApp({ model: "sonnet" }, async (app) => {
        // 空の channelId でスコープを組むと壊れた解決になるため、未指定と同じ結果になること。
        const res = await app.request("/settings/th-1?parentId=");
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.model, { value: "sonnet", source: "default" });
      });
    },
  );

  await t.step(
    "PATCH /settings/:id: 設定が保存され、更新後の解決結果が返ること",
    async () => {
      await withApp({}, async (app) => {
        const res = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus", effort: "high" }),
        });
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.model, { value: "opus", source: "channel" });
        assertEquals(json.effort, { value: "high", source: "channel" });
      });
    },
  );

  await t.step(
    "PATCH /settings/:id: null 指定で設定が削除されること",
    async () => {
      await withApp({ model: "sonnet" }, async (app) => {
        await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });

        const res = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: null }),
        });
        assertEquals(res.status, 200);
        const json = await res.json();
        assertEquals(json.model, { value: "sonnet", source: "default" });
      });
    },
  );

  await t.step(
    "PATCH /settings/:id: 空ボディが 400 になること",
    async () => {
      await withApp({}, async (app) => {
        const res = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        assertEquals(res.status, 400);
        assertErrorBody(await res.json());
      });
    },
  );

  await t.step(
    "PATCH /settings/:id: 未知のキーが 400 になり、何も書き込まれないこと",
    async () => {
      await withApp({}, async (app) => {
        const res = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus", unknownKey: "x" }),
        });
        assertEquals(res.status, 400);
        assertErrorBody(await res.json());

        // 拒否されたリクエストが部分的に適用されていないことを確かめる。
        const after = await (await app.request("/settings/ch-1")).json();
        assertEquals(after.model, undefined);
      });
    },
  );

  await t.step(
    "PATCH /settings/:id: session に文字列を渡すと 400 になり、書き込まれないこと",
    async () => {
      await withApp({}, async (app) => {
        const res = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: "session-a" }),
        });
        assertEquals(res.status, 400);
        assertErrorBody(await res.json());

        const after = await (await app.request("/settings/ch-1")).json();
        assertEquals(after.session, undefined);
      });
    },
  );

  await t.step(
    "PATCH /settings/:id: 不正な JSON が 400 になること",
    async () => {
      await withApp({}, async (app) => {
        const res = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "not-json",
        });
        assertEquals(res.status, 400);
        assertErrorBody(await res.json());
      });
    },
  );

  await t.step(
    "DELETE /settings/:id: 設定が全削除され { ok: true } が返ること",
    async () => {
      await withApp({}, async (app) => {
        await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });

        const res = await app.request("/settings/ch-1", {
          method: "DELETE",
        });
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { ok: true });

        const getRes = await app.request("/settings/ch-1");
        const json = await getRes.json();
        assertEquals(json.model, undefined);
      });
    },
  );

  await t.step(
    "DELETE /settings/:id: 親チャンネルの設定が消えないこと",
    async () => {
      await withApp({}, async (app) => {
        await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });
        await app.request("/settings/th-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "haiku" }),
        });

        await app.request("/settings/th-1", { method: "DELETE" });

        const res = await app.request("/settings/ch-1");
        const json = await res.json();
        assertEquals(json.model, { value: "opus", source: "channel" });
      });
    },
  );
});
