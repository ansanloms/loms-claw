import { assertEquals } from "@std/assert";
import { SessionStore } from "./mod.ts";

Deno.test("SessionStore", async (t) => {
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
