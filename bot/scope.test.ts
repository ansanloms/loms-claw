import { assertEquals } from "@std/assert";
import { scopeFromChannel, type ScopeChannel } from "./scope.ts";

function threadChannel(parentId: string | null): ScopeChannel {
  return {
    parentId,
    isThread: () => true,
  };
}

function textChannel(): ScopeChannel {
  return {
    parentId: null,
    isThread: () => false,
  };
}

Deno.test("scopeFromChannel", async (t) => {
  await t.step(
    "スレッドなら { channelId: parentId, threadId: fallbackChannelId } を返すこと",
    () => {
      const scope = scopeFromChannel(threadChannel("parent-1"), "thread-1");
      assertEquals(scope, { channelId: "parent-1", threadId: "thread-1" });
    },
  );

  await t.step(
    "通常チャンネルなら { channelId: fallbackChannelId } を返すこと",
    () => {
      const scope = scopeFromChannel(textChannel(), "channel-1");
      assertEquals(scope, { channelId: "channel-1" });
    },
  );

  await t.step(
    "スレッドの parentId が null なら fallbackChannelId にフォールバックすること",
    () => {
      const scope = scopeFromChannel(threadChannel(null), "thread-1");
      assertEquals(scope, { channelId: "thread-1", threadId: "thread-1" });
    },
  );

  await t.step(
    "channel が null / undefined なら通常チャンネル扱いになること",
    () => {
      assertEquals(scopeFromChannel(null, "channel-1"), {
        channelId: "channel-1",
      });
      assertEquals(scopeFromChannel(undefined, "channel-1"), {
        channelId: "channel-1",
      });
    },
  );
});
