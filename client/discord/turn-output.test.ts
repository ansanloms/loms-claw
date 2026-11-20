import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { GuildTextBasedChannel } from "discord.js";
import { summarizeError } from "../../errors.ts";
import { DISCORD_MESSAGE_LIMIT } from "./message.ts";
import {
  buildTemplateVars,
  createTurnOutput,
  resolveSpeaker,
  type TurnMessage,
} from "./turn-output.ts";

/** send の内容を記録するフェイクチャンネル。 */
function fakeChannel() {
  const sent: string[] = [];
  const channel = {
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve({});
    },
    sendTyping: () => Promise.resolve(),
  } as unknown as GuildTextBasedChannel;
  return { channel, sent };
}

/** author.id だけを持つ最小のメッセージ。 */
function fakeMessage(authorId: string): TurnMessage {
  return { author: { id: authorId } } as unknown as TurnMessage;
}

describe("resolveSpeaker", () => {
  const base = {
    authorId: "bot-1",
    authorDisplayName: "Bot",
    authorizedUserId: "user-1",
  };

  test("自己メッセージでは認可ユーザーを発話者にすること", () => {
    const speaker = resolveSpeaker({
      ...base,
      isSelfMessage: true,
      lookupDisplayName: (id) => (id === "user-1" ? "Alice" : undefined),
    });
    assert.deepStrictEqual(speaker, { id: "user-1", name: "Alice" });
  });

  test("自己メッセージで表示名が引けなければ ID を名前に使うこと", () => {
    const speaker = resolveSpeaker({
      ...base,
      isSelfMessage: true,
      lookupDisplayName: () => undefined,
    });
    assert.deepStrictEqual(speaker, { id: "user-1", name: "user-1" });
  });

  test("人間のメッセージでは投稿者を発話者にすること", () => {
    const speaker = resolveSpeaker({
      ...base,
      authorId: "user-2",
      authorDisplayName: "Bob",
      isSelfMessage: false,
      lookupDisplayName: () => {
        throw new Error("呼ばれないこと");
      },
    });
    assert.deepStrictEqual(speaker, { id: "user-2", name: "Bob" });
  });
});

describe("resolveSpeaker: 表示名", () => {
  const base = {
    authorId: "user-2",
    authorDisplayName: "Bob (global)",
    authorizedUserId: "user-1",
    lookupDisplayName: () => undefined,
  };

  test("人間のメッセージでは memberDisplayName があればそれを使うこと", () => {
    const speaker = resolveSpeaker({
      ...base,
      isSelfMessage: false,
      memberDisplayName: "Bob (nick)",
    });
    assert.deepStrictEqual(speaker, { id: "user-2", name: "Bob (nick)" });
  });

  test("人間のメッセージでは memberDisplayName が無ければグローバル名を使うこと", () => {
    const speaker = resolveSpeaker({ ...base, isSelfMessage: false });
    assert.deepStrictEqual(speaker, { id: "user-2", name: "Bob (global)" });
  });

  test("自己メッセージでは memberDisplayName を無視すること", () => {
    const speaker = resolveSpeaker({
      ...base,
      isSelfMessage: true,
      memberDisplayName: "Bot (nick)",
      lookupDisplayName: () => "Alice",
    });
    assert.deepStrictEqual(speaker, { id: "user-1", name: "Alice" });
  });
});

describe("buildTemplateVars", () => {
  test("発話者・チャンネル・ギルドの変数が組み立てられること", () => {
    const vars = buildTemplateVars({
      guildId: "g-1",
      guildName: "guild",
      localId: "th-1",
      channelName: "general",
      isThread: true,
      speaker: { id: "user-1", name: "Alice" },
    });
    assert.deepStrictEqual(vars, {
      "discord.guild.id": "g-1",
      "discord.guild.name": "guild",
      "discord.channel.id": "th-1",
      "discord.channel.name": "general",
      "discord.channel.type": "thread",
      "discord.user.id": "user-1",
      "discord.user.name": "Alice",
    });
  });

  test("スレッドでなければ channel.type が text になること", () => {
    const vars = buildTemplateVars({
      guildId: "g-1",
      guildName: "guild",
      localId: "ch-1",
      channelName: "general",
      isThread: false,
      speaker: { id: "user-1", name: "Alice" },
    });
    assert.deepStrictEqual(vars["discord.channel.type"], "text");
  });
});

describe("createTurnOutput", () => {
  test("sendReply: 自己メッセージではメンションを付けないこと", async () => {
    const { channel, sent } = fakeChannel();
    const output = createTurnOutput({
      message: fakeMessage("bot-1"),
      channel,
      isSelfMessage: true,
      hasAttachments: false,
    });

    await output.sendReply("hello");

    assert.deepStrictEqual(sent, ["hello"]);
  });

  test("message 無しでは、返信にメンションが付かないこと", async () => {
    const { channel, sent } = fakeChannel();
    const output = createTurnOutput({
      channel,
      isSelfMessage: false,
      hasAttachments: false,
    });

    await output.sendReply("hello");
    await output.notifyError(new Error("boom"));

    assert.deepStrictEqual(sent, ["hello", summarizeError(new Error("boom"))]);
  });

  test("message 無しでは、キュー待ちでも onQueued・onTurnStart がリアクションに触れず、添付も見ないこと", async () => {
    const { channel } = fakeChannel();
    let downloaded = 0;
    const output = createTurnOutput({
      channel,
      isSelfMessage: false,
      hasAttachments: true,
      deps: {
        downloadImages: () => {
          downloaded += 1;
          return Promise.resolve([]);
        },
        cleanupImages: () => Promise.resolve(),
      },
    });

    output.onQueued();
    await output.onTurnStart();
    const prompt = await output.preparePrompt("hello");
    await output.onTurnEnd();

    assert.deepStrictEqual(prompt, "hello");
    assert.deepStrictEqual(downloaded, 0);
  });

  test("sendReply: 人間のメッセージでは各チャンクに投稿者宛のメンションが付き 2000 文字以内であること", async () => {
    const { channel, sent } = fakeChannel();
    const output = createTurnOutput({
      message: fakeMessage("user-2"),
      channel,
      isSelfMessage: false,
      hasAttachments: false,
    });

    await output.sendReply("a".repeat(DISCORD_MESSAGE_LIMIT * 2 + 10));

    assert.deepStrictEqual(sent.length >= 3, true);
    for (const chunk of sent) {
      assert.deepStrictEqual(chunk.startsWith("<@user-2> "), true);
      assert.deepStrictEqual(chunk.length <= DISCORD_MESSAGE_LIMIT, true);
    }
  });

  test("sendThinking: 各行が `> ` で始まりメンションが付かないこと", async () => {
    const { channel, sent } = fakeChannel();
    const output = createTurnOutput({
      message: fakeMessage("user-2"),
      channel,
      isSelfMessage: false,
      hasAttachments: false,
    });

    await output.sendThinking("line1\nline2\n\nline4");

    assert.deepStrictEqual(sent, ["> line1\n> line2\n> \n> line4"]);
    for (const line of sent.join("\n").split("\n")) {
      assert.deepStrictEqual(line.startsWith("> "), true);
    }
  });

  test("notifyError: 要約が送られ、人間のメッセージでは投稿者宛のメンションが付くこと", async () => {
    const error = new Error("boom");
    const self = fakeChannel();
    await createTurnOutput({
      message: fakeMessage("bot-1"),
      channel: self.channel,
      isSelfMessage: true,
      hasAttachments: false,
    }).notifyError(error);
    const human = fakeChannel();
    await createTurnOutput({
      message: fakeMessage("user-2"),
      channel: human.channel,
      isSelfMessage: false,
      hasAttachments: false,
    }).notifyError(error);

    assert.deepStrictEqual(self.sent, [summarizeError(error)]);
    assert.deepStrictEqual(human.sent, [`<@user-2> ${summarizeError(error)}`]);
  });

  /** 保留中の Promise 連鎖 (⏳ の除去) が済むまでイベントループを回す。 */
  async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** react の戻り値 (MessageReaction) から users.remove を記録するフェイク。 */
  function fakeReaction(removed: string[]) {
    return {
      users: {
        remove: (id?: string) => {
          removed.push(id ?? "self");
          return Promise.resolve();
        },
      },
    };
  }

  test("onTurnStart: onQueued を経たターンだけ bot の ⏳ リアクションを外すこと", async () => {
    for (const queued of [true, false]) {
      const removed: string[] = [];
      const message = {
        author: { id: "user-2" },
        react: () => Promise.resolve(fakeReaction(removed)),
      } as unknown as TurnMessage;
      const { channel } = fakeChannel();
      const output = createTurnOutput({
        message,
        channel,
        isSelfMessage: false,
        hasAttachments: false,
      });

      if (queued) {
        output.onQueued();
      }
      await output.onTurnStart();
      await output.onTurnEnd();
      await settle();

      assert.deepStrictEqual(removed, queued ? ["self"] : []);
    }
  });

  test("onTurnEnd: onQueued の後 onTurnStart を経ずに終わったターンでも ⏳ を外し、onTurnStart を経たターンでは二重に外さないこと", async () => {
    for (const started of [false, true]) {
      const removed: string[] = [];
      const message = {
        author: { id: "user-2" },
        react: () => Promise.resolve(fakeReaction(removed)),
      } as unknown as TurnMessage;
      const { channel } = fakeChannel();
      const output = createTurnOutput({
        message,
        channel,
        isSelfMessage: false,
        hasAttachments: false,
      });

      output.onQueued();
      if (started) {
        await output.onTurnStart();
        await settle();
      }
      await output.onTurnEnd();
      await settle();

      assert.deepStrictEqual(removed, ["self"], `started=${started}`);
    }
  });

  test("onTurnStart: react が失敗したら外そうとしないこと", async () => {
    const removed: string[] = [];
    let reacted = 0;
    const message = {
      author: { id: "user-2" },
      react: () => {
        reacted++;
        return Promise.reject(new Error("react failed"));
      },
    } as unknown as TurnMessage;
    const { channel } = fakeChannel();
    const output = createTurnOutput({
      message,
      channel,
      isSelfMessage: false,
      hasAttachments: false,
    });

    output.onQueued();
    await output.onTurnStart();
    await output.onTurnEnd();
    await settle();

    assert.deepStrictEqual(reacted, 1);
    assert.deepStrictEqual(removed, []);
  });

  test("onTurnStart: react が解決しなくてもすぐ戻り、後から解決したら ⏳ を外すこと", async () => {
    const removed: string[] = [];
    let resolveReact: (reaction: unknown) => void = () => {};
    const message = {
      author: { id: "user-2" },
      react: () =>
        new Promise((resolve) => {
          resolveReact = resolve;
        }),
    } as unknown as TurnMessage;
    const { channel } = fakeChannel();
    const output = createTurnOutput({
      message,
      channel,
      isSelfMessage: false,
      hasAttachments: false,
    });

    output.onQueued();
    await output.onTurnStart();
    assert.deepStrictEqual(removed, []);

    resolveReact(fakeReaction(removed));
    await settle();
    await output.onTurnEnd();

    assert.deepStrictEqual(removed, ["self"]);
  });

  test("preparePrompt: 画像のみのメッセージでは既定文言に画像参照を付けること", async () => {
    const { channel } = fakeChannel();
    const images = [{ path: "/tmp/x/a.png", originalName: "a.png" }];
    const output = createTurnOutput({
      message: {
        author: { id: "user-2" },
        attachments: new Map(),
      } as unknown as TurnMessage,
      channel,
      isSelfMessage: false,
      hasAttachments: true,
      deps: {
        downloadImages: () => Promise.resolve(images),
        cleanupImages: () => Promise.resolve(),
      },
    });

    const prompt = await output.preparePrompt("");

    assert.deepStrictEqual(
      prompt?.startsWith("この画像について説明して"),
      true,
    );
    assert.deepStrictEqual(prompt?.includes("/tmp/x/a.png"), true);
  });

  test("preparePrompt: 添付が無ければそのまま返し、画像を取得しないこと", async () => {
    const { channel } = fakeChannel();
    const output = createTurnOutput({
      message: fakeMessage("user-2"),
      channel,
      isSelfMessage: false,
      hasAttachments: false,
      deps: {
        downloadImages: () => Promise.reject(new Error("呼ばれないこと")),
        cleanupImages: () => Promise.reject(new Error("呼ばれないこと")),
      },
    });

    assert.deepStrictEqual(await output.preparePrompt("text"), "text");
    await output.onTurnEnd();
  });

  test("onTurnEnd: typing を止め、取得済みの画像を後片付けすること", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    let typingCount = 0;
    const channel = {
      send: () => Promise.resolve({}),
      sendTyping: () => {
        typingCount++;
        return Promise.resolve();
      },
    } as unknown as GuildTextBasedChannel;
    const images = [{ path: "/tmp/x/a.png", originalName: "a.png" }];
    const cleaned: unknown[] = [];
    const output = createTurnOutput({
      message: {
        author: { id: "user-2" },
        attachments: new Map(),
      } as unknown as TurnMessage,
      channel,
      isSelfMessage: false,
      hasAttachments: true,
      deps: {
        downloadImages: () => Promise.resolve(images),
        cleanupImages: (imgs) => {
          cleaned.push(imgs);
          return Promise.resolve();
        },
      },
    });

    await output.onTurnStart();
    await output.preparePrompt("x");
    t.mock.timers.tick(10_000);
    const beforeEnd = typingCount;
    assert.deepStrictEqual(beforeEnd >= 2, true);

    await output.onTurnEnd();
    t.mock.timers.tick(30_000);

    assert.deepStrictEqual(typingCount, beforeEnd);
    assert.deepStrictEqual(cleaned, [images]);
  });
});
