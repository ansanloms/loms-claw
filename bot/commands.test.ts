import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Store, type StoreScope } from "../store/mod.ts";
import { handleSettingsSet, handleSettingsUnset } from "./commands.ts";

/**
 * `:memory:` DB を持つ Store を生成し、関数実行後に必ず close する。
 */
async function withStore(
  fn: (store: Store) => Promise<void> | void,
): Promise<void> {
  const db = new DatabaseSync(":memory:");
  const store = new Store(db, {});
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

const ch = (channelId: string): StoreScope => ({ channelId });
const th = (channelId: string, threadId: string): StoreScope => ({
  channelId,
  threadId,
});

/**
 * ChatInputCommandInteraction の最小モック。
 * handleSettingsSet / handleSettingsUnset が使うプロパティのみ実装する。
 *
 * threadParentId:
 *   - undefined: 非 thread (interaction.channel.isThread() === false)
 *   - string:    thread + 親 ID あり
 *   - null:      thread だが parentId が null の異常系 (フォーラム親が消えた等)
 */
function mockInteraction(
  channelId: string,
  options: Record<string, string | boolean>,
  threadParentId?: string | null,
) {
  let replied = false;
  let replyContent = "";
  const channel =
    threadParentId !== undefined
      ? {
          isThread() {
            return true;
          },
          parentId: threadParentId,
        }
      : {
          isThread() {
            return false;
          },
        };
  return {
    channelId,
    channel,
    options: {
      getString(name: string, _required?: boolean) {
        const v = options[name];
        return typeof v === "string" ? v : null;
      },
      getBoolean(name: string, _required?: boolean) {
        const v = options[name];
        return typeof v === "boolean" ? v : null;
      },
    },
    get replied() {
      return replied;
    },
    reply(opts: { content: string; flags?: number }) {
      replied = true;
      replyContent = opts.content;
      return Promise.resolve();
    },
    getReplyContent() {
      return replyContent;
    },
  };
}

describe("handleSettingsSet", () => {
  test("model のみ指定で設定されること", () =>
    withStore(async (store) => {
      const interaction = mockInteraction("ch-1", { model: "opus" }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), "opus");
      assert.deepStrictEqual(await store.getEffort(ch("ch-1")), undefined);
    }));

  test("effort のみ指定で設定されること", () =>
    withStore(async (store) => {
      const interaction = mockInteraction("ch-1", { effort: "high" }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getEffort(ch("ch-1")), "high");
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), undefined);
    }));

  test("model と effort を同時に設定できること", () =>
    withStore(async (store) => {
      const interaction = mockInteraction("ch-1", {
        model: "sonnet",
        effort: "max",
      }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), "sonnet");
      assert.deepStrictEqual(await store.getEffort(ch("ch-1")), "max");
    }));

  test("どちらも未指定で何も設定されないこと", () =>
    withStore(async (store) => {
      const interaction = mockInteraction("ch-1", {}) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), undefined);
      assert.deepStrictEqual(await store.getEffort(ch("ch-1")), undefined);
      assert.deepStrictEqual(
        interaction.getReplyContent(),
        "Specify at least one of `model` / `effort` / `show_thinking` / `active`.",
      );
    }));

  test("show_thinking のみ指定で設定されること", () =>
    withStore(async (store) => {
      const interaction = mockInteraction("ch-1", {
        show_thinking: true,
      }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getShowThinking(ch("ch-1")), true);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), undefined);
    }));

  test("show_thinking = false も明示指定として保存されること", () =>
    withStore(async (store) => {
      // defaults true でも channel に false を明示できる
      await store.applyPatch(ch("ch-1"), { showThinking: true });
      const interaction = mockInteraction("ch-1", {
        show_thinking: false,
      }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getShowThinking(ch("ch-1")), false);
    }));

  test("スレッド内で実行すると thread スコープに保存され channel には影響しないこと", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-parent"), { model: "opus" });
      const interaction = mockInteraction(
        "thread-1",
        { model: "haiku" },
        "ch-parent",
      ) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(
        await store.getModel(th("ch-parent", "thread-1")),
        "haiku",
      );
      // 親チャンネルは無傷
      assert.deepStrictEqual(await store.getModel(ch("ch-parent")), "opus");
    }));

  test("active のみ指定で設定されること", () =>
    withStore(async (store) => {
      const interaction = mockInteraction("ch-1", {
        active: true,
      }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getActive(ch("ch-1")), true);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), undefined);
    }));

  test("active = false も明示指定として保存されること", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-1"), { active: true });
      const interaction = mockInteraction("ch-1", {
        active: false,
      }) as any;
      await handleSettingsSet(interaction, store);
      assert.deepStrictEqual(await store.getActive(ch("ch-1")), false);
    }));

  test("parentId が null の異常スレッドでは thread.id を channelId にもフォールバックして書き込めること", () =>
    withStore(async (store) => {
      const interaction = mockInteraction(
        "orphan-thread",
        { model: "haiku" },
        null,
      ) as any;
      await handleSettingsSet(interaction, store);
      // channelId === threadId === "orphan-thread" として保存される
      assert.deepStrictEqual(
        await store.getModel({
          channelId: "orphan-thread",
          threadId: "orphan-thread",
        }),
        "haiku",
      );
    }));
});

describe("handleSettingsUnset", () => {
  test("target=model でチャンネルの model のみ削除されること", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      await store.setSession(ch("ch-1"), "sess-1");

      const interaction = mockInteraction("ch-1", {
        target: "model",
      }) as any;
      await handleSettingsUnset(interaction, store);

      assert.deepStrictEqual(await store.getModel(ch("ch-1")), undefined);
      assert.deepStrictEqual(await store.getEffort(ch("ch-1")), "high");
      assert.deepStrictEqual(await store.getSession(ch("ch-1")), "sess-1");
    }));

  test("target=effort でチャンネルの effort のみ削除されること", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-1"), { effort: "high" });
      await store.applyPatch(ch("ch-1"), { model: "opus" });

      const interaction = mockInteraction("ch-1", {
        target: "effort",
      }) as any;
      await handleSettingsUnset(interaction, store);

      assert.deepStrictEqual(await store.getEffort(ch("ch-1")), undefined);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), "opus");
    }));

  test("target=show_thinking でチャンネルの showThinking のみ削除されること", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-1"), { showThinking: true });
      await store.applyPatch(ch("ch-1"), { model: "opus" });

      const interaction = mockInteraction("ch-1", {
        target: "show_thinking",
      }) as any;
      await handleSettingsUnset(interaction, store);

      // 削除後は defaults (= false) へフォールバック
      assert.deepStrictEqual(await store.getShowThinking(ch("ch-1")), false);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), "opus");
    }));

  test("target=active でチャンネルの active のみ削除されること", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-1"), { active: true });
      await store.applyPatch(ch("ch-1"), { model: "opus" });

      const interaction = mockInteraction("ch-1", {
        target: "active",
      }) as any;
      await handleSettingsUnset(interaction, store);

      assert.deepStrictEqual(await store.getActive(ch("ch-1")), undefined);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), "opus");
    }));

  test("target=session でチャンネルの session のみ削除されること", () =>
    withStore(async (store) => {
      await store.setSession(ch("ch-1"), "sess-1");
      await store.applyPatch(ch("ch-1"), { model: "opus" });

      const interaction = mockInteraction("ch-1", {
        target: "session",
      }) as any;
      await handleSettingsUnset(interaction, store);

      assert.deepStrictEqual(await store.getSession(ch("ch-1")), undefined);
      assert.deepStrictEqual(await store.getModel(ch("ch-1")), "opus");
    }));

  test("他チャンネルには影響しないこと", () =>
    withStore(async (store) => {
      await store.applyPatch(ch("ch-1"), { model: "opus" });
      await store.applyPatch(ch("ch-2"), { model: "sonnet" });

      const interaction = mockInteraction("ch-1", { target: "model" }) as any;
      await handleSettingsUnset(interaction, store);

      assert.deepStrictEqual(await store.getModel(ch("ch-1")), undefined);
      assert.deepStrictEqual(await store.getModel(ch("ch-2")), "sonnet");
    }));

  test("スレッド内で target=session を実行すると thread の session のみ削除され channel の session は残ること", () =>
    withStore(async (store) => {
      await store.setSession(ch("ch-parent"), "sess-channel");
      await store.setSession(th("ch-parent", "thread-1"), "sess-thread");

      const interaction = mockInteraction(
        "thread-1",
        { target: "session" },
        "ch-parent",
      ) as any;
      await handleSettingsUnset(interaction, store);

      assert.deepStrictEqual(
        await store.getSession(th("ch-parent", "thread-1")),
        undefined,
      );
      assert.deepStrictEqual(
        await store.getSession(ch("ch-parent")),
        "sess-channel",
      );
    }));
});
