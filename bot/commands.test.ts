import { assertEquals } from "@std/assert";
import { Store } from "../store/mod.ts";
import { handleStatusSet, handleStatusUnset } from "./commands.ts";

/**
 * `:memory:` KV を持つ Store を生成し、関数実行後に必ず close する。
 */
async function withStore(
  fn: (store: Store) => Promise<void> | void,
): Promise<void> {
  const kv = await Deno.openKv(":memory:");
  const store = new Store(kv, {});
  try {
    await fn(store);
  } finally {
    store.close();
  }
}

/**
 * ChatInputCommandInteraction の最小モック。
 * handleStatusSet / handleStatusUnset が使うプロパティのみ実装する。
 */
function mockInteraction(channelId: string, options: Record<string, string>) {
  let replied = false;
  let replyContent = "";
  return {
    channelId,
    options: {
      getString(name: string, _required?: boolean) {
        return options[name] ?? null;
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

Deno.test("handleStatusSet", async (t) => {
  await t.step(
    "model のみ指定で設定されること",
    () =>
      withStore(async (store) => {
        // deno-lint-ignore no-explicit-any
        const interaction = mockInteraction("ch-1", { model: "opus" }) as any;
        await handleStatusSet(interaction, store);
        assertEquals(await store.getModel("ch-1"), "opus");
        assertEquals(await store.getEffort("ch-1"), undefined);
      }),
  );

  await t.step(
    "effort のみ指定で設定されること",
    () =>
      withStore(async (store) => {
        // deno-lint-ignore no-explicit-any
        const interaction = mockInteraction("ch-1", { effort: "high" }) as any;
        await handleStatusSet(interaction, store);
        assertEquals(await store.getEffort("ch-1"), "high");
        assertEquals(await store.getModel("ch-1"), undefined);
      }),
  );

  await t.step(
    "model と effort を同時に設定できること",
    () =>
      withStore(async (store) => {
        const interaction = mockInteraction("ch-1", {
          model: "sonnet",
          effort: "max",
          // deno-lint-ignore no-explicit-any
        }) as any;
        await handleStatusSet(interaction, store);
        assertEquals(await store.getModel("ch-1"), "sonnet");
        assertEquals(await store.getEffort("ch-1"), "max");
      }),
  );

  await t.step(
    "どちらも未指定で何も設定されないこと",
    () =>
      withStore(async (store) => {
        // deno-lint-ignore no-explicit-any
        const interaction = mockInteraction("ch-1", {}) as any;
        await handleStatusSet(interaction, store);
        assertEquals(await store.getModel("ch-1"), undefined);
        assertEquals(await store.getEffort("ch-1"), undefined);
        assertEquals(
          interaction.getReplyContent(),
          "Specify at least one of `model` or `effort`.",
        );
      }),
  );
});

Deno.test("handleStatusUnset", async (t) => {
  await t.step(
    "target=model でチャンネルの model のみ削除されること",
    () =>
      withStore(async (store) => {
        await store.setModel("ch-1", "opus");
        await store.setEffort("ch-1", "high");
        await store.setSession("ch-1", "sess-1");

        const interaction = mockInteraction("ch-1", {
          target: "model",
          // deno-lint-ignore no-explicit-any
        }) as any;
        await handleStatusUnset(interaction, store);

        assertEquals(await store.getModel("ch-1"), undefined);
        assertEquals(await store.getEffort("ch-1"), "high");
        assertEquals(await store.getSession("ch-1"), "sess-1");
      }),
  );

  await t.step(
    "target=effort でチャンネルの effort のみ削除されること",
    () =>
      withStore(async (store) => {
        await store.setEffort("ch-1", "high");
        await store.setModel("ch-1", "opus");

        const interaction = mockInteraction("ch-1", {
          target: "effort",
          // deno-lint-ignore no-explicit-any
        }) as any;
        await handleStatusUnset(interaction, store);

        assertEquals(await store.getEffort("ch-1"), undefined);
        assertEquals(await store.getModel("ch-1"), "opus");
      }),
  );

  await t.step(
    "target=session でチャンネルの session のみ削除されること",
    () =>
      withStore(async (store) => {
        await store.setSession("ch-1", "sess-1");
        await store.setModel("ch-1", "opus");

        const interaction = mockInteraction("ch-1", {
          target: "session",
          // deno-lint-ignore no-explicit-any
        }) as any;
        await handleStatusUnset(interaction, store);

        assertEquals(await store.getSession("ch-1"), undefined);
        assertEquals(await store.getModel("ch-1"), "opus");
      }),
  );

  await t.step(
    "他チャンネルには影響しないこと",
    () =>
      withStore(async (store) => {
        await store.setModel("ch-1", "opus");
        await store.setModel("ch-2", "sonnet");

        // deno-lint-ignore no-explicit-any
        const interaction = mockInteraction("ch-1", { target: "model" }) as any;
        await handleStatusUnset(interaction, store);

        assertEquals(await store.getModel("ch-1"), undefined);
        assertEquals(await store.getModel("ch-2"), "sonnet");
      }),
  );
});
