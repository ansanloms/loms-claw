import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Config } from "../config.ts";
import {
  type IncomingMessageDeps,
  type IncomingMessageInput,
  resolveIncomingMessage,
} from "./incoming.ts";
import type { ScopeChannel } from "./scope.ts";

const baseConfig: Config = {
  discord: {
    token: "token",
    guildId: "guild-1",
    userId: "user-1",
    activeChannelIds: ["ch-active-1"],
  },
  storePath: "/tmp/test-loms-claw.sqlite",
  claude: {
    maxTurns: 10,
    timeout: 300000,
    cwd: "/tmp",
    apiPort: 3000,
    defaults: {},
  },
  log: {
    level: "INFO",
    bufferSize: 1000,
  },
};

/** `scopeFromChannel()` に渡す最小チャンネル。 */
function fakeChannel(
  isThread: boolean,
  parentId: string | null = null,
): ScopeChannel {
  return {
    isThread: () => isThread,
    parentId,
  };
}

const baseInput: IncomingMessageInput = {
  guildId: "guild-1",
  authorId: "user-1",
  authorIsBot: false,
  botUserId: "bot-1",
  channel: fakeChannel(false),
  channelId: "ch-1",
  isThread: false,
  parentId: null,
  hasNonBotMentions: false,
};

/** deps の既定値。個々のテストで上書きする。 */
function baseDeps(overrides: Partial<IncomingMessageDeps> = {}) {
  const calls: { getActiveOverride: unknown[] } = { getActiveOverride: [] };
  const deps: IncomingMessageDeps = {
    config: baseConfig,
    isMentioned: () => false,
    getActiveOverride: (scope) => {
      calls.getActiveOverride.push(scope);
      return Promise.resolve(undefined);
    },
    isSelfMentionRateLimited: () => false,
    ...overrides,
  };
  return { deps, calls };
}

describe("resolveIncomingMessage", () => {
  test("認可 NG のメッセージは無視すること", async () => {
    const { deps } = baseDeps();
    const decision = await resolveIncomingMessage(
      { ...baseInput, guildId: "guild-other" },
      deps,
    );
    assert.deepStrictEqual(decision, {
      kind: "ignore",
      reason: "unauthorized",
    });
  });

  test("通常メンションで処理対象 (handle, isSelfMessage: false) になること", async () => {
    const { deps } = baseDeps({ isMentioned: () => true });
    const decision = await resolveIncomingMessage(baseInput, deps);
    if (decision.kind !== "handle") {
      throw new Error("expected handle decision");
    }
    assert.deepStrictEqual(decision.isSelfMessage, false);
    assert.deepStrictEqual(decision.scope, { channelId: "ch-1" });
    assert.deepStrictEqual(decision.localId, "ch-1");
  });

  test("active チャンネルでは mention 無しでも処理対象になること", async () => {
    const { deps } = baseDeps({ isMentioned: () => false });
    const decision = await resolveIncomingMessage(
      { ...baseInput, channelId: "ch-active-1", channel: fakeChannel(false) },
      deps,
    );
    assert.deepStrictEqual(decision.kind, "handle");
  });

  test("active チャンネル配下のスレッドでは mention 無しでも処理対象になること", async () => {
    const { deps } = baseDeps({ isMentioned: () => false });
    const decision = await resolveIncomingMessage(
      {
        ...baseInput,
        channelId: "thread-1",
        channel: fakeChannel(true, "ch-active-1"),
        isThread: true,
        parentId: "ch-active-1",
      },
      deps,
    );
    if (decision.kind !== "handle") {
      throw new Error("expected handle decision");
    }
    assert.deepStrictEqual(decision.scope, {
      channelId: "ch-active-1",
      threadId: "thread-1",
    });
    assert.deepStrictEqual(decision.localId, "thread-1");
  });

  test("自己メンションでレート制限超過の場合は無視すること", async () => {
    const { deps } = baseDeps({
      isMentioned: () => true,
      isSelfMentionRateLimited: () => true,
    });
    const decision = await resolveIncomingMessage(
      { ...baseInput, authorId: "bot-1", authorIsBot: true },
      deps,
    );
    assert.deepStrictEqual(decision, {
      kind: "ignore",
      reason: "rate-limited",
    });
  });

  test("自己メンションでレート制限に掛からなければ処理対象 (isSelfMessage: true) になること", async () => {
    const { deps, calls } = baseDeps({
      isMentioned: () => true,
      isSelfMentionRateLimited: () => false,
    });
    const decision = await resolveIncomingMessage(
      { ...baseInput, authorId: "bot-1", authorIsBot: true },
      deps,
    );
    if (decision.kind !== "handle") {
      throw new Error("expected handle decision");
    }
    assert.deepStrictEqual(decision.isSelfMessage, true);
    // 自己メッセージでは active 上書き (ストア読み取り) を引かない
    assert.deepStrictEqual(calls.getActiveOverride.length, 0);
  });

  test("自己メンションで mention が無い場合は無視すること", async () => {
    const { deps } = baseDeps({ isMentioned: () => false });
    const decision = await resolveIncomingMessage(
      { ...baseInput, authorId: "bot-1", authorIsBot: true },
      deps,
    );
    assert.deepStrictEqual(decision, {
      kind: "ignore",
      reason: "self-not-mentioned",
    });
  });

  test("mention 無し・非 active チャンネルは応答不要として無視すること", async () => {
    const { deps } = baseDeps({ isMentioned: () => false });
    const decision = await resolveIncomingMessage(baseInput, deps);
    assert.deepStrictEqual(decision, {
      kind: "ignore",
      reason: "not-responding",
    });
  });
});
