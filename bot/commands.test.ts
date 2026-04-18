import { assertEquals } from "@std/assert";
import { Store } from "../store/mod.ts";
import { handleClear } from "./commands.ts";

/**
 * ChatInputCommandInteraction の最小モック。
 * handleClear が使うプロパティのみ実装する。
 */
function mockInteraction(channelId: string) {
  let replied = false;
  let replyContent = "";
  return {
    channelId,
    get replied() {
      return replied;
    },
    reply(options: { content: string; flags?: number }) {
      replied = true;
      replyContent = options.content;
      return Promise.resolve();
    },
    getReplyContent() {
      return replyContent;
    },
  };
}

async function newStore(): Promise<Store> {
  const kv = await Deno.openKv(":memory:");
  return new Store(kv, {});
}

Deno.test("handleClear", { sanitizeResources: false }, async (t) => {
  await t.step("対象チャンネルの session のみ削除されること", async () => {
    const store = await newStore();
    await store.setSession("ch-1", "sess-1");
    await store.setSession("ch-2", "sess-2");

    // deno-lint-ignore no-explicit-any
    const interaction = mockInteraction("ch-1") as any;
    await handleClear(interaction, store);

    assertEquals(await store.getSession("ch-1"), undefined);
    assertEquals(await store.getSession("ch-2"), "sess-2");
  });

  await t.step(
    "model / effort には触らず session のみ削除されること",
    async () => {
      const store = await newStore();
      await store.setSession("ch-1", "sess-1");
      await store.setModel("ch-1", "opus");
      await store.setEffort("ch-1", "high");

      // deno-lint-ignore no-explicit-any
      const interaction = mockInteraction("ch-1") as any;
      await handleClear(interaction, store);

      assertEquals(await store.getSession("ch-1"), undefined);
      assertEquals(await store.getModel("ch-1"), "opus");
      assertEquals(await store.getEffort("ch-1"), "high");
    },
  );

  await t.step("インタラクションに応答すること", async () => {
    const store = await newStore();
    const interaction = mockInteraction("ch-1");

    // deno-lint-ignore no-explicit-any
    await handleClear(interaction as any, store);

    assertEquals(interaction.replied, true);
    assertEquals(interaction.getReplyContent(), "Session cleared.");
  });
});
