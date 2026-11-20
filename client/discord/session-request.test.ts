import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { type Client, PermissionFlagsBits } from "discord.js";
import type { TurnInput } from "../../core/conversation.ts";
import {
  submitSessionRequest,
  type SessionRequestDeps,
} from "./session-request.ts";

const GUILD = "guild-1";
const USER = "user-1";

interface FakeChannelOptions {
  guildId?: string;
  thread?: boolean;
  parentId?: string | null;
  sendable?: boolean;
  textBased?: boolean;
  dmBased?: boolean;
  /** bot が持つ権限。未指定なら必要な権限をすべて持つ。 */
  permissions?: bigint[];
  /** 権限が引けない (親チャンネルが無いスレッド等)。 */
  noPermissions?: boolean;
  locked?: boolean;
}

function fakeChannel(options: FakeChannelOptions = {}) {
  const thread = options.thread ?? false;
  return {
    id: "ignored",
    name: thread ? "thread-name" : "channel-name",
    guildId: options.guildId ?? GUILD,
    locked: options.locked ?? false,
    client: { user: { id: "bot-1" } },
    permissionsFor: () => {
      if (options.noPermissions) {
        return null;
      }
      const granted = options.permissions ?? [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
      ];
      return { has: (flag: bigint) => granted.includes(flag) };
    },
    parentId: options.parentId ?? null,
    guild: {
      name: "Guild Name",
      members: { cache: { get: () => ({ displayName: "Owner" }) } },
    },
    send: () => Promise.resolve({}),
    isThread: () => thread,
    isTextBased: () => options.textBased ?? true,
    isDMBased: () => options.dmBased ?? false,
    isSendable: () => options.sendable ?? true,
  };
}

function createDeps(args: {
  fetch: (id: string) => Promise<unknown>;
  exhausted?: boolean;
  closed?: boolean;
  submit?: (input: TurnInput) => Promise<void>;
}) {
  const submitted: TurnInput[] = [];
  let consumed = 0;
  const fetched: string[] = [];
  const deps: SessionRequestDeps = {
    client: {
      channels: {
        fetch: (id: string) => {
          fetched.push(id);
          return args.fetch(id);
        },
      },
      users: { cache: { get: () => undefined } },
    } as unknown as Pick<Client, "channels" | "users">,
    guildId: GUILD,
    userId: USER,
    conversation: {
      submit: (input) => {
        submitted.push(input);
        return args.submit ? args.submit(input) : Promise.resolve();
      },
    },
    limiter: {
      tryConsume: () => {
        consumed += 1;
        return !(args.exhausted ?? false);
      },
    },
    isClosed: () => args.closed ?? false,
  };
  return { deps, submitted, fetched, consumed: () => consumed };
}

describe("submitSessionRequest", () => {
  test("終了処理中なら unavailable で、宛先の取得も枠の消費も submit もしないこと", async () => {
    const { deps, submitted, fetched, consumed } = createDeps({
      fetch: () => Promise.reject(new Error("must not be called")),
      closed: true,
    });

    const result = await submitSessionRequest(
      { channelId: "c1" },
      "hi",
      undefined,
      deps,
    );

    assert.deepStrictEqual(result, "unavailable");
    assert.deepStrictEqual(fetched, []);
    assert.deepStrictEqual(consumed(), 0);
    assert.deepStrictEqual(submitted, []);
  });

  test("チャンネルの取得が reject したら not-found で、submit しないこと", async () => {
    const { deps, submitted } = createDeps({
      fetch: () => Promise.reject(new Error("Unknown Channel")),
    });

    const result = await submitSessionRequest(
      { channelId: "c1" },
      "hi",
      undefined,
      deps,
    );

    assert.deepStrictEqual(result, "not-found");
    assert.deepStrictEqual(submitted, []);
  });

  test("チャンネルの取得が null なら not-found であること", async () => {
    const { deps } = createDeps({ fetch: () => Promise.resolve(null) });

    assert.deepStrictEqual(
      await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
      "not-found",
    );
  });

  test("ギルド外のチャンネルは not-found であること", async () => {
    const { deps } = createDeps({
      fetch: () => Promise.resolve(fakeChannel({ guildId: "other" })),
    });

    assert.deepStrictEqual(
      await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
      "not-found",
    );
  });

  test("送信できない種別 (テキスト系でない・DM・送信不可) は not-found であること", async () => {
    for (const options of [
      { textBased: false },
      { dmBased: true },
      { sendable: false },
    ]) {
      const { deps } = createDeps({
        fetch: () => Promise.resolve(fakeChannel(options)),
      });

      assert.deepStrictEqual(
        await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
        "not-found",
        JSON.stringify(options),
      );
    }
  });

  test("channelId の経路でスレッドを指したら not-found であること", async () => {
    const { deps } = createDeps({
      fetch: () =>
        Promise.resolve(fakeChannel({ thread: true, parentId: "p" })),
    });

    assert.deepStrictEqual(
      await submitSessionRequest({ channelId: "t1" }, "hi", undefined, deps),
      "not-found",
    );
  });

  test("スレッドの親が channelId と一致しなければ not-found であること", async () => {
    const { deps, submitted } = createDeps({
      fetch: () =>
        Promise.resolve(fakeChannel({ thread: true, parentId: "other" })),
    });

    const result = await submitSessionRequest(
      { channelId: "c1", threadId: "t1" },
      "hi",
      undefined,
      deps,
    );

    assert.deepStrictEqual(result, "not-found");
    assert.deepStrictEqual(submitted, []);
  });

  test("threadId の経路で非スレッドのチャンネルを指したら not-found であること", async () => {
    const { deps } = createDeps({
      fetch: () => Promise.resolve(fakeChannel()),
    });

    assert.deepStrictEqual(
      await submitSessionRequest(
        { channelId: "c1", threadId: "t1" },
        "hi",
        undefined,
        deps,
      ),
      "not-found",
    );
  });

  test("送信権限が無い (View / SendMessages 欠け・権限が引けない) チャンネルは not-found で、枠を消費しないこと", async () => {
    for (const options of [
      { permissions: [PermissionFlagsBits.SendMessages] },
      { permissions: [PermissionFlagsBits.ViewChannel] },
      { noPermissions: true },
    ]) {
      const { deps, submitted, consumed } = createDeps({
        fetch: () => Promise.resolve(fakeChannel(options)),
      });

      assert.deepStrictEqual(
        await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
        "not-found",
        JSON.stringify(options, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
      );
      assert.deepStrictEqual(submitted, []);
      assert.deepStrictEqual(consumed(), 0);
    }
  });

  test("スレッド: SendMessagesInThreads または ViewChannel が無い、ロック中なら not-found であること", async () => {
    for (const options of [
      { permissions: [PermissionFlagsBits.ViewChannel] },
      { permissions: [PermissionFlagsBits.SendMessagesInThreads] },
      { locked: true },
      { noPermissions: true },
    ]) {
      const { deps } = createDeps({
        fetch: () =>
          Promise.resolve(
            fakeChannel({ thread: true, parentId: "c1", ...options }),
          ),
      });

      assert.deepStrictEqual(
        await submitSessionRequest(
          { channelId: "c1", threadId: "t1" },
          "hi",
          undefined,
          deps,
        ),
        "not-found",
        JSON.stringify(options, (_, v) => (typeof v === "bigint" ? `${v}` : v)),
      );
    }
  });

  test("スレッドは SendMessages が無くても、SendMessagesInThreads と ViewChannel があれば受け付けること", async () => {
    const { deps } = createDeps({
      fetch: () =>
        Promise.resolve(
          fakeChannel({
            thread: true,
            parentId: "c1",
            permissions: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessagesInThreads,
            ],
          }),
        ),
    });

    assert.deepStrictEqual(
      await submitSessionRequest(
        { channelId: "c1", threadId: "t1" },
        "hi",
        undefined,
        deps,
      ),
      "accepted",
    );
  });

  test("枠が尽きていれば rate-limited で、submit しないこと", async () => {
    const { deps, submitted } = createDeps({
      fetch: () => Promise.resolve(fakeChannel()),
      exhausted: true,
    });

    const result = await submitSessionRequest(
      { channelId: "c1" },
      "hi",
      undefined,
      deps,
    );

    assert.deepStrictEqual(result, "rate-limited");
    assert.deepStrictEqual(submitted, []);
  });

  test("受け付けた依頼ごとに受付時に枠を 1 つ消費し、枠が尽きた次の依頼から rate-limited になること", async () => {
    let remaining = 2;
    const { deps, submitted } = createDeps({
      fetch: () => Promise.resolve(fakeChannel()),
    });
    deps.limiter = { tryConsume: () => remaining-- > 0 };

    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
      );
    }

    assert.deepStrictEqual(results, ["accepted", "accepted", "rate-limited"]);
    assert.deepStrictEqual(submitted.length, 2);
  });

  test("対象が not-found のときは枠を消費しないこと", async () => {
    const { deps, consumed } = createDeps({
      fetch: () => Promise.resolve(null),
    });

    await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps);

    assert.deepStrictEqual(consumed(), 0);
  });

  test("対象が存在しなければ、枠が尽きていても not-found であること", async () => {
    const { deps } = createDeps({
      fetch: () => Promise.resolve(null),
      exhausted: true,
    });

    assert.deepStrictEqual(
      await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
      "not-found",
    );
  });

  test("チャンネル宛: scope・localId・templateVars・sessionRequest を submit に渡すこと", async () => {
    const { deps, submitted, fetched } = createDeps({
      fetch: () => Promise.resolve(fakeChannel()),
    });

    const result = await submitSessionRequest(
      { channelId: "c1" },
      "hi",
      "cron:news.md",
      deps,
    );

    assert.deepStrictEqual(result, "accepted");
    assert.deepStrictEqual(fetched, ["c1"]);
    assert.deepStrictEqual(submitted, [
      {
        scope: { channelId: "c1" },
        localId: "c1",
        prompt: "hi",
        isSelfMessage: false,
        templateVars: {
          "discord.guild.id": GUILD,
          "discord.guild.name": "Guild Name",
          "discord.channel.id": "c1",
          "discord.channel.name": "channel-name",
          "discord.channel.type": "text",
          "discord.user.id": USER,
          "discord.user.name": "Owner",
        },
        sessionRequest: { source: "cron:news.md" },
      },
    ]);
  });

  test("スレッド宛: スレッドを取得し、thread スコープと localId を組むこと。source が無ければ sessionRequest は空であること", async () => {
    const { deps, submitted, fetched } = createDeps({
      fetch: () =>
        Promise.resolve(fakeChannel({ thread: true, parentId: "c1" })),
    });

    const result = await submitSessionRequest(
      { channelId: "c1", threadId: "t1" },
      "hi",
      undefined,
      deps,
    );

    assert.deepStrictEqual(result, "accepted");
    assert.deepStrictEqual(fetched, ["t1"]);
    assert.deepStrictEqual(submitted[0]?.scope, {
      channelId: "c1",
      threadId: "t1",
    });
    assert.deepStrictEqual(submitted[0]?.localId, "t1");
    assert.deepStrictEqual(
      submitted[0]?.templateVars["discord.channel.type"],
      "thread",
    );
    assert.deepStrictEqual(submitted[0]?.sessionRequest, {});
  });

  test("submit が reject しても accepted を返し、例外を漏らさないこと", async () => {
    const { deps } = createDeps({
      fetch: () => Promise.resolve(fakeChannel()),
      submit: () => Promise.reject(new Error("boom")),
    });

    assert.deepStrictEqual(
      await submitSessionRequest({ channelId: "c1" }, "hi", undefined, deps),
      "accepted",
    );
    await new Promise((resolve) => setImmediate(resolve));
  });
});
