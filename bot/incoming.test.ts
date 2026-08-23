import { assertEquals } from "@std/assert";
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
  storePath: "/tmp/test-loms-claw.kv",
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

Deno.test("resolveIncomingMessage", async (t) => {
  await t.step("認可 NG のメッセージは無視すること", async () => {
    const { deps } = baseDeps();
    const decision = await resolveIncomingMessage(
      { ...baseInput, guildId: "guild-other" },
      deps,
    );
    assertEquals(decision, { kind: "ignore", reason: "unauthorized" });
  });

  await t.step(
    "通常メンションで処理対象 (handle, isSelfMessage: false) になること",
    async () => {
      const { deps } = baseDeps({ isMentioned: () => true });
      const decision = await resolveIncomingMessage(baseInput, deps);
      if (decision.kind !== "handle") {
        throw new Error("expected handle decision");
      }
      assertEquals(decision.isSelfMessage, false);
      assertEquals(decision.scope, { channelId: "ch-1" });
      assertEquals(decision.localId, "ch-1");
    },
  );

  await t.step(
    "active チャンネルでは mention 無しでも処理対象になること",
    async () => {
      const { deps } = baseDeps({ isMentioned: () => false });
      const decision = await resolveIncomingMessage(
        { ...baseInput, channelId: "ch-active-1", channel: fakeChannel(false) },
        deps,
      );
      assertEquals(decision.kind, "handle");
    },
  );

  await t.step(
    "active チャンネル配下のスレッドでは mention 無しでも処理対象になること",
    async () => {
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
      assertEquals(decision.scope, {
        channelId: "ch-active-1",
        threadId: "thread-1",
      });
      assertEquals(decision.localId, "thread-1");
    },
  );

  await t.step(
    "自己メンションでレート制限超過の場合は無視すること",
    async () => {
      const { deps } = baseDeps({
        isMentioned: () => true,
        isSelfMentionRateLimited: () => true,
      });
      const decision = await resolveIncomingMessage(
        { ...baseInput, authorId: "bot-1", authorIsBot: true },
        deps,
      );
      assertEquals(decision, { kind: "ignore", reason: "rate-limited" });
    },
  );

  await t.step(
    "自己メンションでレート制限に掛からなければ処理対象 (isSelfMessage: true) になること",
    async () => {
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
      assertEquals(decision.isSelfMessage, true);
      // 自己メッセージでは active 上書き (KV 読み取り) を引かない
      assertEquals(calls.getActiveOverride.length, 0);
    },
  );

  await t.step(
    "自己メンションで mention が無い場合は無視すること",
    async () => {
      const { deps } = baseDeps({ isMentioned: () => false });
      const decision = await resolveIncomingMessage(
        { ...baseInput, authorId: "bot-1", authorIsBot: true },
        deps,
      );
      assertEquals(decision, { kind: "ignore", reason: "self-not-mentioned" });
    },
  );

  await t.step(
    "mention 無し・非 active チャンネルは応答不要として無視すること",
    async () => {
      const { deps } = baseDeps({ isMentioned: () => false });
      const decision = await resolveIncomingMessage(baseInput, deps);
      assertEquals(decision, { kind: "ignore", reason: "not-responding" });
    },
  );
});
