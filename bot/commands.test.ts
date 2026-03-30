import { assertEquals } from "@std/assert";
import { SessionStore } from "../session/mod.ts";
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

Deno.test("handleClear", async (t) => {
  await t.step("セッションが削除されること", async () => {
    const sessions = new SessionStore();
    sessions.set("ch-1", "sess-1");
    sessions.set("ch-2", "sess-2");

    // deno-lint-ignore no-explicit-any
    const interaction = mockInteraction("ch-1") as any;
    await handleClear(interaction, sessions);

    assertEquals(sessions.get("ch-1"), undefined);
    assertEquals(sessions.get("ch-2"), "sess-2");
  });

  await t.step("インタラクションに応答すること", async () => {
    const sessions = new SessionStore();
    const interaction = mockInteraction("ch-1");

    // deno-lint-ignore no-explicit-any
    await handleClear(interaction as any, sessions);

    assertEquals(interaction.replied, true);
    assertEquals(interaction.getReplyContent(), "Session cleared.");
  });
});
