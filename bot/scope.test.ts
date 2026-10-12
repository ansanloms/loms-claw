import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type ScopeChannel, scopeFromChannel } from "./scope.ts";

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

describe("scopeFromChannel", () => {
  test("スレッドなら { channelId: parentId, threadId: fallbackChannelId } を返すこと", () => {
    const scope = scopeFromChannel(threadChannel("parent-1"), "thread-1");
    assert.deepStrictEqual(scope, {
      channelId: "parent-1",
      threadId: "thread-1",
    });
  });

  test("通常チャンネルなら { channelId: fallbackChannelId } を返すこと", () => {
    const scope = scopeFromChannel(textChannel(), "channel-1");
    assert.deepStrictEqual(scope, { channelId: "channel-1" });
  });

  test("スレッドの parentId が null なら fallbackChannelId にフォールバックすること", () => {
    const scope = scopeFromChannel(threadChannel(null), "thread-1");
    assert.deepStrictEqual(scope, {
      channelId: "thread-1",
      threadId: "thread-1",
    });
  });

  test("channel が null / undefined なら通常チャンネル扱いになること", () => {
    assert.deepStrictEqual(scopeFromChannel(null, "channel-1"), {
      channelId: "channel-1",
    });
    assert.deepStrictEqual(scopeFromChannel(undefined, "channel-1"), {
      channelId: "channel-1",
    });
  });
});
