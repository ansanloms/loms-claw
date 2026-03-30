import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { SessionStore } from "./mod.ts";

Deno.test("SessionStore (インメモリ)", async (t) => {
  await t.step("未登録のキーは undefined を返すこと", () => {
    const store = new SessionStore();
    assertEquals(store.get("ch-1"), undefined);
  });

  await t.step("set したセッションを get で取得できること", () => {
    const store = new SessionStore();
    store.set("ch-1", "session-a");
    assertEquals(store.get("ch-1"), "session-a");
  });

  await t.step("同じキーに set すると上書きされること", () => {
    const store = new SessionStore();
    store.set("ch-1", "session-a");
    store.set("ch-1", "session-b");
    assertEquals(store.get("ch-1"), "session-b");
  });

  await t.step("delete でセッションが削除されること", () => {
    const store = new SessionStore();
    store.set("ch-1", "session-a");
    assertEquals(store.delete("ch-1"), true);
    assertEquals(store.get("ch-1"), undefined);
  });

  await t.step("未登録のキーを delete すると false を返すこと", () => {
    const store = new SessionStore();
    assertEquals(store.delete("ch-unknown"), false);
  });

  await t.step("clear で全セッションが削除されること", () => {
    const store = new SessionStore();
    store.set("ch-1", "session-a");
    store.set("ch-2", "session-b");
    store.clear();
    assertEquals(store.get("ch-1"), undefined);
    assertEquals(store.get("ch-2"), undefined);
  });
});

Deno.test("SessionStore (ファイル永続化)", async (t) => {
  await t.step("ファイル未存在で起動できること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "sessions.json");
      const store = new SessionStore(path);
      assertEquals(store.get("ch-1"), undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("set でファイルに書き込まれること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "sessions.json");
      const store = new SessionStore(path);
      store.set("ch-1", "session-a");

      const data = JSON.parse(Deno.readTextFileSync(path));
      assertEquals(data, { "ch-1": "session-a" });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("ファイルからセッションを復元できること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "sessions.json");
      Deno.writeTextFileSync(
        path,
        JSON.stringify({ "ch-1": "session-a", "ch-2": "session-b" }),
      );

      const store = new SessionStore(path);
      assertEquals(store.get("ch-1"), "session-a");
      assertEquals(store.get("ch-2"), "session-b");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("delete でファイルが更新されること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "sessions.json");
      const store = new SessionStore(path);
      store.set("ch-1", "session-a");
      store.set("ch-2", "session-b");
      store.delete("ch-1");

      const data = JSON.parse(Deno.readTextFileSync(path));
      assertEquals(data, { "ch-2": "session-b" });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("clear でファイルが空オブジェクトになること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "sessions.json");
      const store = new SessionStore(path);
      store.set("ch-1", "session-a");
      store.set("ch-2", "session-b");
      store.clear();

      const data = JSON.parse(Deno.readTextFileSync(path));
      assertEquals(data, {});
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("不正な JSON でもエラーにならず起動すること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "sessions.json");
      Deno.writeTextFileSync(path, "{broken json!!!");

      const store = new SessionStore(path);
      assertEquals(store.get("ch-1"), undefined);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });

  await t.step("親ディレクトリが自動作成されること", async () => {
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "nested", "deep", "sessions.json");
      const store = new SessionStore(path);
      store.set("ch-1", "session-a");

      const data = JSON.parse(Deno.readTextFileSync(path));
      assertEquals(data, { "ch-1": "session-a" });
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});
