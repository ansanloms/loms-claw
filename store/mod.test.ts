import { assertEquals } from "@std/assert";
import { Store, type StoreDefaults } from "./mod.ts";

async function withStore(
  defaults: StoreDefaults,
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  try {
    const store = new Store(kv, defaults);
    await fn(store);
  } finally {
    kv.close();
  }
}

Deno.test("Store - session", async (t) => {
  await t.step("未登録のキーは undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getSession("ch-1"), undefined);
    });
  });

  await t.step("set したセッション ID を get で取得できること", async () => {
    await withStore({}, async (store) => {
      await store.setSession("ch-1", "session-a");
      assertEquals(await store.getSession("ch-1"), "session-a");
    });
  });

  await t.step("同じキーに set すると上書きされること", async () => {
    await withStore({}, async (store) => {
      await store.setSession("ch-1", "session-a");
      await store.setSession("ch-1", "session-b");
      assertEquals(await store.getSession("ch-1"), "session-b");
    });
  });

  await t.step("delete でセッション ID が消えること", async () => {
    await withStore({}, async (store) => {
      await store.setSession("ch-1", "session-a");
      await store.deleteSession("ch-1");
      assertEquals(await store.getSession("ch-1"), undefined);
    });
  });
});

Deno.test("Store - model", async (t) => {
  await t.step("未登録 + defaults 無しで undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getModel("ch-1"), undefined);
    });
  });

  await t.step(
    "未登録時は defaults.model にフォールバックすること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        assertEquals(await store.getModel("ch-1"), "sonnet");
      });
    },
  );

  await t.step(
    "チャンネルに set した値が defaults より優先されること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel("ch-1", "opus");
        assertEquals(await store.getModel("ch-1"), "opus");
      });
    },
  );

  await t.step("delete 後は defaults に戻ること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.setModel("ch-1", "opus");
      await store.deleteModel("ch-1");
      assertEquals(await store.getModel("ch-1"), "sonnet");
    });
  });
});

Deno.test("Store - effort", async (t) => {
  await t.step(
    "未登録時は defaults.effort にフォールバックすること",
    async () => {
      await withStore({ effort: "medium" }, async (store) => {
        assertEquals(await store.getEffort("ch-1"), "medium");
      });
    },
  );

  await t.step(
    "チャンネルに set した値が defaults より優先されること",
    async () => {
      await withStore({ effort: "medium" }, async (store) => {
        await store.setEffort("ch-1", "high");
        assertEquals(await store.getEffort("ch-1"), "high");
      });
    },
  );

  await t.step("delete 後は defaults に戻ること", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      await store.setEffort("ch-1", "high");
      await store.deleteEffort("ch-1");
      assertEquals(await store.getEffort("ch-1"), "medium");
    });
  });
});

Deno.test("Store - clearChannel", async (t) => {
  await t.step(
    "session / model / effort が同時に削除され、defaults は残ること",
    async () => {
      await withStore({ model: "sonnet", effort: "medium" }, async (store) => {
        await store.setSession("ch-1", "session-a");
        await store.setModel("ch-1", "opus");
        await store.setEffort("ch-1", "high");

        await store.clearChannel("ch-1");

        assertEquals(await store.getSession("ch-1"), undefined);
        assertEquals(await store.getModel("ch-1"), "sonnet");
        assertEquals(await store.getEffort("ch-1"), "medium");
      });
    },
  );

  await t.step("他チャンネルの値には影響しないこと", async () => {
    await withStore({}, async (store) => {
      await store.setSession("ch-1", "session-a");
      await store.setSession("ch-2", "session-b");

      await store.clearChannel("ch-1");

      assertEquals(await store.getSession("ch-1"), undefined);
      assertEquals(await store.getSession("ch-2"), "session-b");
    });
  });
});

Deno.test("Store - getChannelSettings", async (t) => {
  await t.step(
    "全て未設定 + defaults 無しで undefined になること",
    async () => {
      await withStore({}, async (store) => {
        const s = await store.getChannelSettings("ch-1");
        assertEquals(s.session, undefined);
        assertEquals(s.model, undefined);
        assertEquals(s.effort, undefined);
      });
    },
  );

  await t.step(
    "チャンネル上書きの source が 'channel' になること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel("ch-1", "opus");
        const s = await store.getChannelSettings("ch-1");
        assertEquals(s.model, { value: "opus", source: "channel" });
      });
    },
  );

  await t.step(
    "defaults フォールバックの source が 'default' になること",
    async () => {
      await withStore({ model: "sonnet", effort: "medium" }, async (store) => {
        const s = await store.getChannelSettings("ch-1");
        assertEquals(s.model, { value: "sonnet", source: "default" });
        assertEquals(s.effort, { value: "medium", source: "default" });
      });
    },
  );

  await t.step("session も含めて返ること", async () => {
    await withStore({}, async (store) => {
      await store.setSession("ch-1", "session-x");
      const s = await store.getChannelSettings("ch-1");
      assertEquals(s.session, "session-x");
    });
  });
});

Deno.test("Store - cron 用の擬似 channelId", async (t) => {
  await t.step(
    "'cron:<name>' を channelId として使っても動作すること",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession("cron:daily", "session-cron");
        assertEquals(await store.getSession("cron:daily"), "session-cron");
      });
    },
  );
});
