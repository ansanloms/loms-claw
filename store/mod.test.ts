import { assertEquals } from "@std/assert";
import { Store, type StoreDefaults, type StoreScope } from "./mod.ts";

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

const ch = (channelId: string): StoreScope => ({ channelId });
const th = (channelId: string, threadId: string): StoreScope => ({
  channelId,
  threadId,
});

Deno.test("Store - session", async (t) => {
  await t.step("未登録のキーは undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getSession(ch("ch-1")), undefined);
    });
  });

  await t.step("set したセッション ID を get で取得できること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      assertEquals(await store.getSession(ch("ch-1")), "session-a");
    });
  });

  await t.step("同じスコープに set すると上書きされること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.setSession(ch("ch-1"), "session-b");
      assertEquals(await store.getSession(ch("ch-1")), "session-b");
    });
  });

  await t.step("delete でセッション ID が消えること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.deleteSession(ch("ch-1"));
      assertEquals(await store.getSession(ch("ch-1")), undefined);
    });
  });

  await t.step(
    "thread の session は channel の session にフォールバックしないこと",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession(ch("ch-1"), "session-channel");
        assertEquals(
          await store.getSession(th("ch-1", "th-1")),
          undefined,
        );
      });
    },
  );

  await t.step(
    "thread と channel の session は独立に保持されること",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession(ch("ch-1"), "session-channel");
        await store.setSession(th("ch-1", "th-1"), "session-thread");
        assertEquals(
          await store.getSession(ch("ch-1")),
          "session-channel",
        );
        assertEquals(
          await store.getSession(th("ch-1", "th-1")),
          "session-thread",
        );
      });
    },
  );

  await t.step(
    "thread の session を delete しても channel の session は残ること",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession(ch("ch-1"), "session-channel");
        await store.setSession(th("ch-1", "th-1"), "session-thread");
        await store.deleteSession(th("ch-1", "th-1"));
        assertEquals(
          await store.getSession(th("ch-1", "th-1")),
          undefined,
        );
        assertEquals(
          await store.getSession(ch("ch-1")),
          "session-channel",
        );
      });
    },
  );
});

Deno.test("Store - model", async (t) => {
  await t.step("未登録 + defaults 無しで undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getModel(ch("ch-1")), undefined);
    });
  });

  await t.step(
    "未登録時は defaults.model にフォールバックすること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        assertEquals(await store.getModel(ch("ch-1")), "sonnet");
      });
    },
  );

  await t.step(
    "チャンネルに set した値が defaults より優先されること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        assertEquals(await store.getModel(ch("ch-1")), "opus");
      });
    },
  );

  await t.step("delete 後は defaults に戻ること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.setModel(ch("ch-1"), "opus");
      await store.deleteModel(ch("ch-1"));
      assertEquals(await store.getModel(ch("ch-1")), "sonnet");
    });
  });

  await t.step(
    "thread に未設定なら channel の値にフォールバックすること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        assertEquals(
          await store.getModel(th("ch-1", "th-1")),
          "opus",
        );
      });
    },
  );

  await t.step(
    "thread / channel どちらも未設定なら defaults にフォールバックすること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        assertEquals(
          await store.getModel(th("ch-1", "th-1")),
          "sonnet",
        );
      });
    },
  );

  await t.step(
    "thread に set した値が channel の値より優先されること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        await store.setModel(th("ch-1", "th-1"), "haiku");
        assertEquals(
          await store.getModel(th("ch-1", "th-1")),
          "haiku",
        );
        // channel 側は影響を受けない
        assertEquals(await store.getModel(ch("ch-1")), "opus");
      });
    },
  );

  await t.step(
    "thread の delete で channel の値にフォールバックすること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        await store.setModel(th("ch-1", "th-1"), "haiku");
        await store.deleteModel(th("ch-1", "th-1"));
        assertEquals(
          await store.getModel(th("ch-1", "th-1")),
          "opus",
        );
      });
    },
  );
});

Deno.test("Store - effort", async (t) => {
  await t.step(
    "未登録時は defaults.effort にフォールバックすること",
    async () => {
      await withStore({ effort: "medium" }, async (store) => {
        assertEquals(await store.getEffort(ch("ch-1")), "medium");
      });
    },
  );

  await t.step(
    "チャンネルに set した値が defaults より優先されること",
    async () => {
      await withStore({ effort: "medium" }, async (store) => {
        await store.setEffort(ch("ch-1"), "high");
        assertEquals(await store.getEffort(ch("ch-1")), "high");
      });
    },
  );

  await t.step("delete 後は defaults に戻ること", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      await store.setEffort(ch("ch-1"), "high");
      await store.deleteEffort(ch("ch-1"));
      assertEquals(await store.getEffort(ch("ch-1")), "medium");
    });
  });

  await t.step(
    "thread / channel / defaults のフォールバックチェーンが効くこと",
    async () => {
      await withStore({ effort: "medium" }, async (store) => {
        // defaults のみ
        assertEquals(
          await store.getEffort(th("ch-1", "th-1")),
          "medium",
        );
        // channel のみ
        await store.setEffort(ch("ch-1"), "high");
        assertEquals(
          await store.getEffort(th("ch-1", "th-1")),
          "high",
        );
        // thread が channel より優先
        await store.setEffort(th("ch-1", "th-1"), "low");
        assertEquals(
          await store.getEffort(th("ch-1", "th-1")),
          "low",
        );
      });
    },
  );
});

Deno.test("Store - clearScope", async (t) => {
  await t.step(
    "channel スコープで session / model / effort が同時に削除され、defaults は残ること",
    async () => {
      await withStore({ model: "sonnet", effort: "medium" }, async (store) => {
        await store.setSession(ch("ch-1"), "session-a");
        await store.setModel(ch("ch-1"), "opus");
        await store.setEffort(ch("ch-1"), "high");

        await store.clearScope(ch("ch-1"));

        assertEquals(await store.getSession(ch("ch-1")), undefined);
        assertEquals(await store.getModel(ch("ch-1")), "sonnet");
        assertEquals(await store.getEffort(ch("ch-1")), "medium");
      });
    },
  );

  await t.step("他チャンネルの値には影響しないこと", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.setSession(ch("ch-2"), "session-b");

      await store.clearScope(ch("ch-1"));

      assertEquals(await store.getSession(ch("ch-1")), undefined);
      assertEquals(await store.getSession(ch("ch-2")), "session-b");
    });
  });

  await t.step(
    "thread スコープの clearScope で thread のみ消え channel が残ること",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession(ch("ch-1"), "session-channel");
        await store.setModel(ch("ch-1"), "opus");
        await store.setSession(th("ch-1", "th-1"), "session-thread");
        await store.setModel(th("ch-1", "th-1"), "haiku");

        await store.clearScope(th("ch-1", "th-1"));

        // thread 配下は消える
        assertEquals(
          await store.getSession(th("ch-1", "th-1")),
          undefined,
        );
        // channel 値は残るので thread からのフォールバックも回復
        assertEquals(
          await store.getModel(th("ch-1", "th-1")),
          "opus",
        );
        // channel 直接アクセスも変わらない
        assertEquals(
          await store.getSession(ch("ch-1")),
          "session-channel",
        );
        assertEquals(await store.getModel(ch("ch-1")), "opus");
      });
    },
  );
});

Deno.test("Store - getScopeSettings", async (t) => {
  await t.step(
    "channel スコープで全て未設定 + defaults 無しなら undefined になること",
    async () => {
      await withStore({}, async (store) => {
        const s = await store.getScopeSettings(ch("ch-1"));
        assertEquals(s.session, undefined);
        assertEquals(s.model, undefined);
        assertEquals(s.effort, undefined);
      });
    },
  );

  await t.step(
    "channel 上書きの source が 'channel' になること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        const s = await store.getScopeSettings(ch("ch-1"));
        assertEquals(s.model, { value: "opus", source: "channel" });
      });
    },
  );

  await t.step(
    "defaults フォールバックの source が 'default' になること",
    async () => {
      await withStore({ model: "sonnet", effort: "medium" }, async (store) => {
        const s = await store.getScopeSettings(ch("ch-1"));
        assertEquals(s.model, { value: "sonnet", source: "default" });
        assertEquals(s.effort, { value: "medium", source: "default" });
      });
    },
  );

  await t.step("session も含めて返ること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-x");
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.session, "session-x");
    });
  });

  await t.step(
    "thread スコープで thread 値があれば source が 'thread' になること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        await store.setModel(th("ch-1", "th-1"), "haiku");
        const s = await store.getScopeSettings(th("ch-1", "th-1"));
        assertEquals(s.model, { value: "haiku", source: "thread" });
      });
    },
  );

  await t.step(
    "thread スコープで thread 未設定なら channel 値が source 'channel' で返ること",
    async () => {
      await withStore({ model: "sonnet" }, async (store) => {
        await store.setModel(ch("ch-1"), "opus");
        const s = await store.getScopeSettings(th("ch-1", "th-1"));
        assertEquals(s.model, { value: "opus", source: "channel" });
      });
    },
  );

  await t.step(
    "thread スコープで thread / channel 共に未設定なら defaults を 'default' で返すこと",
    async () => {
      await withStore({ effort: "medium" }, async (store) => {
        const s = await store.getScopeSettings(th("ch-1", "th-1"));
        assertEquals(s.effort, { value: "medium", source: "default" });
      });
    },
  );

  await t.step(
    "thread スコープの session は thread のみ参照し channel にフォールバックしないこと",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession(ch("ch-1"), "session-channel");
        const s = await store.getScopeSettings(th("ch-1", "th-1"));
        assertEquals(s.session, undefined);
      });
    },
  );
});

Deno.test("Store - cron 用の擬似 channelId", async (t) => {
  await t.step(
    "'cron:<name>' を channelId として使っても動作すること",
    async () => {
      await withStore({}, async (store) => {
        await store.setSession(ch("cron:daily"), "session-cron");
        assertEquals(
          await store.getSession(ch("cron:daily")),
          "session-cron",
        );
      });
    },
  );
});
