import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { Store, type StoreDefaults } from "../../store/mod.ts";
import { createSettingsRoutes } from "./settings.ts";

async function withApp(
  defaults: StoreDefaults,
  fn: (app: Hono) => Promise<void>,
  resolveParentId?: (id: string) => Promise<string | null>,
): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new Store(db, defaults);
    const app = new Hono();
    app.route("/settings", createSettingsRoutes({ store, resolveParentId }));
    await fn(app);
  } finally {
    db.close();
  }
}

/** エラー応答が ResponseError スキーマ相当の形をしていることを検証する。 */
function assertErrorBody(body: unknown): void {
  assert(
    typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error.length > 0,
    `expected { error: string }, got ${JSON.stringify(body)}`,
  );
}

describe("createSettingsRoutes", () => {
  test("GET /settings/default: defaults が返ること", async () => {
    await withApp({ model: "sonnet", effort: "medium" }, async (app) => {
      const res = await app.request("/settings/default");
      assertEquals(res.status, 200);
      assertEquals(await res.json(), {
        model: "sonnet",
        effort: "medium",
        showThinking: false,
      });
    });
  });

  test("GET /settings/default: showThinking が未設定でも false で返ること", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/default");
      assertEquals(res.status, 200);
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.showThinking, false);
      assertEquals(json.model, undefined);
      assertEquals(json.effort, undefined);
    });
  });

  test("GET /settings/:id: 未設定のスコープでもデフォルト解決の結果が返ること", async () => {
    await withApp({ model: "sonnet" }, async (app) => {
      const res = await app.request("/settings/ch-1");
      assertEquals(res.status, 200);
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.model, { value: "sonnet", source: "default" });
      assertEquals(json.showThinking, { value: false, source: "default" });
    });
  });

  test("GET /settings/:id: resolveParentId がスレッドの親を返す場合、thread → channel のフォールバックが効くこと", async () => {
    await withApp(
      {},
      async (app) => {
        const patchRes = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });
        assertEquals(patchRes.status, 200);

        const res = await app.request("/settings/th-1");
        assertEquals(res.status, 200);
        const json = (await res.json()) as Record<string, unknown>;
        assertEquals(json.model, { value: "opus", source: "channel" });
      },
      (id) => Promise.resolve(id === "th-1" ? "ch-1" : null),
    );
  });

  test("PATCH /settings/:id: resolveParentId がスレッドの親を返す場合、応答が実効設定になること", async () => {
    await withApp(
      {},
      async (app) => {
        // 親チャンネルに effort を設定しておく。
        const parentPatch = await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ effort: "high" }),
        });
        assertEquals(parentPatch.status, 200);

        // スレッドに model を書き込む。応答は thread と channel のフォールバックを
        // 含めた実効設定になるはず。
        const res = await app.request("/settings/th-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });
        assertEquals(res.status, 200);
        const json = (await res.json()) as Record<string, unknown>;
        assertEquals(json.model, { value: "opus", source: "thread" });
        assertEquals(json.effort, { value: "high", source: "channel" });
      },
      (id) => Promise.resolve(id === "th-1" ? "ch-1" : null),
    );
  });

  test("GET /settings/:id: resolveParentId が null を返す場合 (通常チャンネル) は親へフォールバックしないこと", async () => {
    await withApp(
      {},
      async (app) => {
        // th-1 を親に持つかのような値を ch-1 に置くが、resolveParentId は常に null
        // (通常チャンネル扱い) を返すので th-1 の GET はこれを拾わないはず。
        await app.request("/settings/ch-1", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "opus" }),
        });

        const res = await app.request("/settings/th-1");
        assertEquals(res.status, 200);
        const json = (await res.json()) as Record<string, unknown>;
        assertEquals(json.model, undefined);
      },
      () => Promise.resolve(null),
    );
  });

  test("GET /settings/:id: resolveParentId が throw した場合でも 500 にならず、チャンネル扱いで解決されること", async () => {
    await withApp(
      { model: "sonnet" },
      async (app) => {
        const res = await app.request("/settings/th-1");
        assertEquals(res.status, 200);
        const json = (await res.json()) as Record<string, unknown>;
        assertEquals(json.model, { value: "sonnet", source: "default" });
      },
      () => Promise.reject(new Error("channel fetch failed")),
    );
  });

  test("PATCH /settings/:id: 設定が保存され、更新後の解決結果が返ること", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus", effort: "high" }),
      });
      assertEquals(res.status, 200);
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.model, { value: "opus", source: "channel" });
      assertEquals(json.effort, { value: "high", source: "channel" });
    });
  });

  test("PATCH /settings/:id: null 指定で設定が削除されること", async () => {
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
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.model, { value: "sonnet", source: "default" });
    });
  });

  test("PATCH /settings/:id: 空ボディが 400 になること", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assertEquals(res.status, 400);
      assertErrorBody(await res.json());
    });
  });

  test("PATCH /settings/:id: 未知のキーが 400 になり、何も書き込まれないこと", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "opus", unknownKey: "x" }),
      });
      assertEquals(res.status, 400);
      assertErrorBody(await res.json());

      // 拒否されたリクエストが部分的に適用されていないことを確かめる。
      const after = (await (
        await app.request("/settings/ch-1")
      ).json()) as Record<string, unknown>;
      assertEquals(after.model, undefined);
    });
  });

  test("PATCH /settings/:id: session に文字列を渡すと 400 になり、書き込まれないこと", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "session-a" }),
      });
      assertEquals(res.status, 400);
      assertErrorBody(await res.json());

      const after = (await (
        await app.request("/settings/ch-1")
      ).json()) as Record<string, unknown>;
      assertEquals(after.session, undefined);
    });
  });

  test("PATCH /settings/:id: 不正な JSON が 400 になること", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      assertEquals(res.status, 400);
      assertErrorBody(await res.json());
    });
  });

  test("PATCH /settings/:id: active を設定でき、応答に active が含まれること", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true }),
      });
      assertEquals(res.status, 200);
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.active, { value: true, source: "channel" });
    });
  });

  test("PATCH /settings/:id: active: null を送ると応答から active が消えること", async () => {
    await withApp({}, async (app) => {
      await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: true }),
      });

      const res = await app.request("/settings/ch-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: null }),
      });
      assertEquals(res.status, 200);
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.active, undefined);
    });
  });

  test("GET /settings/:id: 未設定なら active がフィールドごと省略されること", async () => {
    await withApp({}, async (app) => {
      const res = await app.request("/settings/ch-1");
      assertEquals(res.status, 200);
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.active, undefined);
      assertEquals("active" in json, false);
    });
  });

  test("DELETE /settings/:id: 設定が全削除され { ok: true } が返ること", async () => {
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
      const json = (await getRes.json()) as Record<string, unknown>;
      assertEquals(json.model, undefined);
    });
  });

  test("DELETE /settings/:id: 親チャンネルの設定が消えないこと", async () => {
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
      const json = (await res.json()) as Record<string, unknown>;
      assertEquals(json.model, { value: "opus", source: "channel" });
    });
  });

  test("DELETE /settings/:id: resolveParentId が親を返しても、消えるのはスレッドの設定だけで親チャンネルの設定が残ること", async () => {
    await withApp(
      {},
      async (app) => {
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

        const delRes = await app.request("/settings/th-1", {
          method: "DELETE",
        });
        assertEquals(delRes.status, 200);

        const res = await app.request("/settings/ch-1");
        const json = (await res.json()) as Record<string, unknown>;
        assertEquals(json.model, { value: "opus", source: "channel" });

        // スレッドの設定は消え、親チャンネルへフォールバックした値が返る。
        const threadRes = await app.request("/settings/th-1");
        const threadJson = (await threadRes.json()) as Record<string, unknown>;
        assertEquals(threadJson.model, { value: "opus", source: "channel" });
      },
      (id) => Promise.resolve(id === "th-1" ? "ch-1" : null),
    );
  });
});
