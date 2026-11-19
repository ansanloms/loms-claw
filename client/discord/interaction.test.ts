import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type Interaction, MessageFlags } from "discord.js";
import type { Config } from "../../config.ts";
import { dispatchInteraction, type InteractionDeps } from "./interaction.ts";

const config: Config = {
  discord: {
    token: "token",
    guildId: "guild-1",
    userId: "user-1",
    activeChannelIds: [],
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

type Kind = "button" | "select" | "modal" | "chat";
const kinds: Kind[] = ["button", "select", "modal", "chat"];

interface FakeUser {
  guildId: string | null;
  userId: string;
  bot: boolean;
}

const authorizedUser: FakeUser = {
  guildId: "guild-1",
  userId: "user-1",
  bot: false,
};

const unauthorizedUsers: Array<[string, FakeUser]> = [
  ["別ユーザー", { ...authorizedUser, userId: "user-2" }],
  ["別ギルド", { ...authorizedUser, guildId: "guild-2" }],
  ["DM", { ...authorizedUser, guildId: null }],
  ["bot", { ...authorizedUser, bot: true }],
];

interface Replies {
  payloads: unknown[];
}

function fakeInteraction(
  kind: Kind,
  user: FakeUser,
  replies: Replies,
  replyError?: Error,
  repliable = true,
): Interaction {
  const fake = {
    guildId: user.guildId,
    user: { id: user.userId, bot: user.bot },
    replied: false,
    deferred: false,
    customId: "custom-id",
    isRepliable: () => repliable,
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "select",
    isModalSubmit: () => kind === "modal",
    isChatInputCommand: () => kind === "chat",
    reply: (payload: unknown) => {
      replies.payloads.push(payload);
      return replyError ? Promise.reject(replyError) : Promise.resolve();
    },
  };
  return fake as unknown as Interaction;
}

function fakeDeps(): { deps: InteractionDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: InteractionDeps = {
    config,
    approvalManager: {
      handleButton: () => {
        calls.push("button");
        return Promise.resolve(true);
      },
      handleSelect: () => {
        calls.push("select");
        return Promise.resolve(true);
      },
      handleModal: () => {
        calls.push("modal");
        return Promise.resolve(true);
      },
    },
    handleCommand: () => {
      calls.push("chat");
      return Promise.resolve();
    },
  };
  return { deps, calls };
}

describe("dispatchInteraction", () => {
  for (const [label, user] of unauthorizedUsers) {
    for (const kind of kinds) {
      test(`${label}の ${kind} はハンドラを呼ばず ephemeral で拒否されること`, async () => {
        const replies: Replies = { payloads: [] };
        const { deps, calls } = fakeDeps();
        await dispatchInteraction(fakeInteraction(kind, user, replies), deps);
        assert.deepStrictEqual(calls, []);
        assert.strictEqual(replies.payloads.length, 1);
        const payload = replies.payloads[0];
        assert.ok(typeof payload === "object" && payload !== null);
        assert.ok("content" in payload && "flags" in payload);
        assert.strictEqual(payload.content, "この操作は許可されていません。");
        assert.strictEqual(payload.flags, MessageFlags.Ephemeral);
      });
    }
  }

  for (const kind of kinds) {
    test(`認可ユーザーの ${kind} は対応するハンドラへ渡ること`, async () => {
      const replies: Replies = { payloads: [] };
      const { deps, calls } = fakeDeps();
      await dispatchInteraction(
        fakeInteraction(kind, authorizedUser, replies),
        deps,
      );
      assert.deepStrictEqual(calls, [kind]);
      assert.deepStrictEqual(replies.payloads, []);
    });
  }

  test("拒否の reply が失敗しても throw せずハンドラも呼ばないこと", async () => {
    const replies: Replies = { payloads: [] };
    const { deps, calls } = fakeDeps();
    await dispatchInteraction(
      fakeInteraction(
        "button",
        unauthorizedUsers[0][1],
        replies,
        new Error("reply failed"),
      ),
      deps,
    );
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(replies.payloads.length, 1);
  });

  test("返信不可の interaction は拒否しても reply もハンドラ呼び出しもしないこと", async () => {
    const replies: Replies = { payloads: [] };
    const { deps, calls } = fakeDeps();
    await dispatchInteraction(
      fakeInteraction(
        "chat",
        unauthorizedUsers[0][1],
        replies,
        undefined,
        false,
      ),
      deps,
    );
    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(replies.payloads, []);
  });

  test("認可ユーザーのハンドラが throw したら ephemeral のエラー文言で返すこと", async () => {
    const replies: Replies = { payloads: [] };
    const { deps } = fakeDeps();
    deps.approvalManager.handleButton = () => Promise.reject(new Error("boom"));
    await dispatchInteraction(
      fakeInteraction("button", authorizedUser, replies),
      deps,
    );
    assert.deepStrictEqual(replies.payloads, [
      {
        content: "承認処理中にエラーが発生しました。",
        flags: MessageFlags.Ephemeral,
      },
    ]);
  });
});
