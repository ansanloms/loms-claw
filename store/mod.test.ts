import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { assertEquals } from "@std/assert";
import { Store, type StoreDefaults, type StoreScope } from "./mod.ts";

async function withStore(
  defaults: StoreDefaults,
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new Store(db, defaults);
    await fn(store);
  } finally {
    db.close();
  }
}

const ch = (channelId: string): StoreScope => ({ channelId });
const th = (channelId: string, threadId: string): StoreScope => ({
  channelId,
  threadId,
});

describe("Store", () => {
  // --- session ---

  test("getSession: 未登録のキーは undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getSession(ch("ch-1")), undefined);
    });
  });

  test("setSession: セットした値を getSession で取得できること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      assertEquals(await store.getSession(ch("ch-1")), "session-a");
    });
  });

  test("setSession: 同じスコープへの再設定で上書きされること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.setSession(ch("ch-1"), "session-b");
      assertEquals(await store.getSession(ch("ch-1")), "session-b");
    });
  });

  test("getSession: session を null で patch すると消えること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.applyPatch(ch("ch-1"), { session: null });
      assertEquals(await store.getSession(ch("ch-1")), undefined);
    });
  });

  test("getSession: thread の値が channel の値にフォールバックしないこと", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-channel");
      assertEquals(await store.getSession(th("ch-1", "th-1")), undefined);
    });
  });

  test("getSession: thread と channel の値が独立に保持されること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-channel");
      await store.setSession(th("ch-1", "th-1"), "session-thread");
      assertEquals(await store.getSession(ch("ch-1")), "session-channel");
      assertEquals(
        await store.getSession(th("ch-1", "th-1")),
        "session-thread",
      );
    });
  });

  test("getSession: thread を session: null で patch しても channel の値は残ること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-channel");
      await store.setSession(th("ch-1", "th-1"), "session-thread");
      await store.applyPatch(th("ch-1", "th-1"), { session: null });
      assertEquals(await store.getSession(th("ch-1", "th-1")), undefined);
      assertEquals(await store.getSession(ch("ch-1")), "session-channel");
    });
  });

  // --- model ---

  test("getModel: 未登録 + defaults 無しで undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getModel(ch("ch-1")), undefined);
    });
  });

  test("getModel: 未登録時は defaults.model にフォールバックすること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      assertEquals(await store.getModel(ch("ch-1")), "sonnet");
    });
  });

  test("getModel: channel 設定が defaults より優先されること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      assertEquals(await store.getModel(ch("ch-1")), "opus");
    });
  });

  test("getModel: model を null で patch すると defaults に戻ること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(ch("ch-1"), { model: null });
      assertEquals(await store.getModel(ch("ch-1")), "sonnet");
    });
  });

  test("getModel: thread 未設定時に channel の値にフォールバックすること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      assertEquals(await store.getModel(th("ch-1", "th-1")), "opus");
    });
  });

  test("getModel: thread / channel どちらも未設定なら defaults にフォールバックすること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      assertEquals(await store.getModel(th("ch-1", "th-1")), "sonnet");
    });
  });

  test("getModel: thread 設定が channel 設定より優先されること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(th("ch-1", "th-1"), { model: "haiku" });
      assertEquals(await store.getModel(th("ch-1", "th-1")), "haiku");
      // channel 側は影響を受けない
      assertEquals(await store.getModel(ch("ch-1")), "opus");
    });
  });

  test("getModel: thread を model: null で patch すると channel の値にフォールバックすること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(th("ch-1", "th-1"), { model: "haiku" });
      await store.applyPatch(th("ch-1", "th-1"), { model: null });
      assertEquals(await store.getModel(th("ch-1", "th-1")), "opus");
    });
  });

  // --- effort ---

  test("getEffort: 未登録時は defaults.effort にフォールバックすること", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      assertEquals(await store.getEffort(ch("ch-1")), "medium");
    });
  });

  test("getEffort: channel 設定が defaults より優先されること", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      assertEquals(await store.getEffort(ch("ch-1")), "high");
    });
  });

  test("getEffort: effort を null で patch すると defaults に戻ること", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      await store.applyPatch(ch("ch-1"), { effort: null });
      assertEquals(await store.getEffort(ch("ch-1")), "medium");
    });
  });

  test("getEffort: thread / channel / defaults のフォールバックチェーンが効くこと", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      // defaults のみ
      assertEquals(await store.getEffort(th("ch-1", "th-1")), "medium");
      // channel のみ
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      assertEquals(await store.getEffort(th("ch-1", "th-1")), "high");
      // thread が channel より優先
      await store.applyPatch(th("ch-1", "th-1"), { effort: "low" });
      assertEquals(await store.getEffort(th("ch-1", "th-1")), "low");
    });
  });

  // --- showThinking ---

  test("getShowThinking: 未登録 + defaults 無しで false を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getShowThinking(ch("ch-1")), false);
    });
  });

  test("getShowThinking: defaults が true なら true を返すこと", async () => {
    await withStore({ showThinking: true }, async (store) => {
      assertEquals(await store.getShowThinking(ch("ch-1")), true);
    });
  });

  test("getShowThinking: channel 上書きが defaults より優先されること", async () => {
    await withStore({ showThinking: true }, async (store) => {
      await store.applyPatch(ch("ch-1"), { showThinking: false });
      assertEquals(await store.getShowThinking(ch("ch-1")), false);
    });
  });

  test("getShowThinking: showThinking を null で patch すると defaults に戻ること", async () => {
    await withStore({ showThinking: true }, async (store) => {
      await store.applyPatch(ch("ch-1"), { showThinking: false });
      await store.applyPatch(ch("ch-1"), { showThinking: null });
      assertEquals(await store.getShowThinking(ch("ch-1")), true);
    });
  });

  test("getShowThinking: thread 設定が channel / defaults より優先されること", async () => {
    await withStore({ showThinking: false }, async (store) => {
      await store.applyPatch(ch("ch-1"), { showThinking: false });
      await store.applyPatch(th("ch-1", "th-1"), { showThinking: true });
      assertEquals(await store.getShowThinking(th("ch-1", "th-1")), true);
    });
  });

  test("getShowThinking: thread 未設定時に channel の値にフォールバックすること", async () => {
    await withStore({ showThinking: false }, async (store) => {
      await store.applyPatch(ch("ch-1"), { showThinking: true });
      assertEquals(await store.getShowThinking(th("ch-1", "th-1")), true);
    });
  });

  test("getShowThinking: thread / channel 共に未設定なら defaults に戻ること", async () => {
    await withStore({ showThinking: true }, async (store) => {
      assertEquals(await store.getShowThinking(th("ch-1", "th-1")), true);
    });
  });

  // --- active ---

  test("getActive: 未設定なら undefined を返すこと", async () => {
    await withStore({}, async (store) => {
      assertEquals(await store.getActive(ch("ch-1")), undefined);
    });
  });

  test("getActive: 設定した値を取得できること", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { active: true });
      assertEquals(await store.getActive(ch("ch-1")), true);
    });
  });

  test("getActive: false を設定した場合 undefined ではなく false を返すこと", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { active: false });
      assertEquals(await store.getActive(ch("ch-1")), false);
    });
  });

  test("getActive: thread 未設定時に channel の値にフォールバックすること", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { active: true });
      assertEquals(await store.getActive(th("ch-1", "th-1")), true);
    });
  });

  test("getActive: thread の false が channel の true より優先されること", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { active: true });
      await store.applyPatch(th("ch-1", "th-1"), { active: false });
      assertEquals(await store.getActive(th("ch-1", "th-1")), false);
    });
  });

  // --- clearScope ---

  test("clearScope: channel スコープで session / model / effort が同時に削除され defaults は残ること", async () => {
    await withStore({ model: "sonnet", effort: "medium" }, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(ch("ch-1"), { effort: "high" });

      await store.clearScope(ch("ch-1"));

      assertEquals(await store.getSession(ch("ch-1")), undefined);
      assertEquals(await store.getModel(ch("ch-1")), "sonnet");
      assertEquals(await store.getEffort(ch("ch-1")), "medium");
    });
  });

  test("clearScope: 他チャンネルの値には影響しないこと", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      await store.setSession(ch("ch-2"), "session-b");

      await store.clearScope(ch("ch-1"));

      assertEquals(await store.getSession(ch("ch-1")), undefined);
      assertEquals(await store.getSession(ch("ch-2")), "session-b");
    });
  });

  test("clearScope: thread スコープでは thread のみ消え channel が残ること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-channel");
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.setSession(th("ch-1", "th-1"), "session-thread");
      await store.applyPatch(th("ch-1", "th-1"), { model: "haiku" });

      await store.clearScope(th("ch-1", "th-1"));

      // thread 配下は消える
      assertEquals(await store.getSession(th("ch-1", "th-1")), undefined);
      // channel 値は残るので thread からのフォールバックも回復
      assertEquals(await store.getModel(th("ch-1", "th-1")), "opus");
      // channel 直接アクセスも変わらない
      assertEquals(await store.getSession(ch("ch-1")), "session-channel");
      assertEquals(await store.getModel(ch("ch-1")), "opus");
    });
  });

  // --- getScopeSettings ---

  test("getScopeSettings: channel スコープで全て未設定 + defaults 無しなら undefined になること", async () => {
    await withStore({}, async (store) => {
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.session, undefined);
      assertEquals(s.model, undefined);
      assertEquals(s.effort, undefined);
    });
  });

  test("getScopeSettings: channel 上書きの source が 'channel' になること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.model, { value: "opus", source: "channel" });
    });
  });

  test("getScopeSettings: defaults フォールバックの source が 'default' になること", async () => {
    await withStore({ model: "sonnet", effort: "medium" }, async (store) => {
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.model, { value: "sonnet", source: "default" });
      assertEquals(s.effort, { value: "medium", source: "default" });
    });
  });

  test("getScopeSettings: session も含めて返ること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-x");
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.session, "session-x");
    });
  });

  test("getScopeSettings: thread スコープで thread 値があれば source が 'thread' になること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(th("ch-1", "th-1"), { model: "haiku" });
      const s = await store.getScopeSettings(th("ch-1", "th-1"));
      assertEquals(s.model, { value: "haiku", source: "thread" });
    });
  });

  test("getScopeSettings: thread スコープで thread 未設定なら channel 値が source 'channel' で返ること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      const s = await store.getScopeSettings(th("ch-1", "th-1"));
      assertEquals(s.model, { value: "opus", source: "channel" });
    });
  });

  test("getScopeSettings: thread スコープで thread / channel 共に未設定なら defaults を 'default' で返すこと", async () => {
    await withStore({ effort: "medium" }, async (store) => {
      const s = await store.getScopeSettings(th("ch-1", "th-1"));
      assertEquals(s.effort, { value: "medium", source: "default" });
    });
  });

  test("getScopeSettings: thread スコープの session は thread のみ参照し channel にフォールバックしないこと", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-channel");
      const s = await store.getScopeSettings(th("ch-1", "th-1"));
      assertEquals(s.session, undefined);
    });
  });

  test("getScopeSettings: showThinking は未設定でも false (source: default) で返ること", async () => {
    await withStore({}, async (store) => {
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.showThinking, { value: false, source: "default" });
    });
  });

  test("getScopeSettings: showThinking の channel 上書きが source 'channel' で返ること", async () => {
    await withStore({ showThinking: false }, async (store) => {
      await store.applyPatch(ch("ch-1"), { showThinking: true });
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.showThinking, { value: true, source: "channel" });
    });
  });

  test("getScopeSettings: active は未設定時 undefined になること", async () => {
    await withStore({}, async (store) => {
      const s = await store.getScopeSettings(ch("ch-1"));
      assertEquals(s.active, undefined);
    });
  });

  // --- applyPatch ---

  test("applyPatch: 複数キーを同時に設定できること", async () => {
    await withStore({}, async (store) => {
      const s = await store.applyPatch(ch("ch-1"), {
        model: "opus",
        effort: "high",
        showThinking: true,
      });
      assertEquals(s.model, { value: "opus", source: "channel" });
      assertEquals(s.effort, { value: "high", source: "channel" });
      assertEquals(s.showThinking, { value: true, source: "channel" });
    });
  });

  test("applyPatch: 省略したキーが変更されないこと", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      assertEquals(await store.getModel(ch("ch-1")), "opus");
      assertEquals(await store.getEffort(ch("ch-1")), "high");
    });
  });

  test("applyPatch: null を指定したキーが削除され、フォールバックへ戻ること", async () => {
    await withStore({ model: "sonnet" }, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      const s = await store.applyPatch(ch("ch-1"), { model: null });
      assertEquals(s.model, { value: "sonnet", source: "default" });
    });
  });

  test("applyPatch: active を設定できること", async () => {
    await withStore({}, async (store) => {
      const s = await store.applyPatch(ch("ch-1"), { active: true });
      assertEquals(s.active, { value: true, source: "channel" });
    });
  });

  test("applyPatch: active: null で削除され getScopeSettings() の active が undefined に戻ること", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { active: true });
      const s = await store.applyPatch(ch("ch-1"), { active: null });
      assertEquals(s.active, undefined);
      assertEquals(
        (await store.getScopeSettings(ch("ch-1"))).active,
        undefined,
      );
    });
  });

  test("applyPatch: session: null でセッションが削除されること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("ch-1"), "session-a");
      const s = await store.applyPatch(ch("ch-1"), { session: null });
      assertEquals(s.session, undefined);
    });
  });

  test("applyPatch: 空の patch を渡しても既存の設定が壊れないこと", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      const s = await store.applyPatch(ch("ch-1"), {});
      assertEquals(s.model, { value: "opus", source: "channel" });
      assertEquals(s.effort, { value: "high", source: "channel" });
    });
  });

  test("applyPatch: 戻り値が更新後の解決結果であること", async () => {
    await withStore({}, async (store) => {
      const s = await store.applyPatch(ch("ch-1"), { model: "opus" });
      assertEquals(s, await store.getScopeSettings(ch("ch-1")));
    });
  });

  test("applyPatch: thread スコープに適用したとき親チャンネルの設定が変わらないこと", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(th("ch-1", "th-1"), { model: "haiku" });
      assertEquals(await store.getModel(ch("ch-1")), "opus");
    });
  });

  test("applyPatch: thread スコープで解決すると thread → channel のフォールバックが効くこと", async () => {
    await withStore({}, async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      const s = await store.applyPatch(th("ch-1", "th-1"), {
        effort: "high",
      });
      assertEquals(s.model, { value: "opus", source: "channel" });
      assertEquals(s.effort, { value: "high", source: "thread" });
    });
  });

  // --- getDefaults ---

  test("getDefaults: コンストラクタに渡した defaults が返ること", async () => {
    await withStore(
      { model: "sonnet", effort: "medium", showThinking: true },
      (store) => {
        assertEquals(store.getDefaults(), {
          model: "sonnet",
          effort: "medium",
          showThinking: true,
        });
        return Promise.resolve();
      },
    );
  });

  test("getDefaults: 返り値を書き換えても内部状態が変わらないこと", async () => {
    await withStore({ model: "sonnet" }, (store) => {
      const defaults = store.getDefaults();
      defaults.model = "opus";
      assertEquals(store.getDefaults().model, "sonnet");
      return Promise.resolve();
    });
  });

  // --- cron 用の擬似 channelId ---

  test("setSession: 'cron:<name>' を channelId として使っても動作すること", async () => {
    await withStore({}, async (store) => {
      await store.setSession(ch("cron:daily"), "session-cron");
      assertEquals(await store.getSession(ch("cron:daily")), "session-cron");
    });
  });
});
