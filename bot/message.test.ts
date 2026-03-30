import { assertEquals } from "@std/assert";
import type { GuildTextBasedChannel } from "discord.js";
import { createProgressReporter, keepTyping, splitMessage } from "./message.ts";

Deno.test("splitMessage", async (t) => {
  await t.step("短いテキストは 1 チャンクで返すこと", () => {
    assertEquals(splitMessage("hello"), ["hello"]);
  });

  await t.step("制限値ちょうどのテキストは 1 チャンクで返すこと", () => {
    const text = "a".repeat(2000);
    assertEquals(splitMessage(text), [text]);
  });

  await t.step("改行位置で分割すること", () => {
    const line1 = "a".repeat(1500);
    const line2 = "b".repeat(600);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text);
    assertEquals(chunks.length, 2);
    assertEquals(chunks[0], line1);
    assertEquals(chunks[1], line2);
  });

  await t.step("後半に改行がない場合は強制分割すること", () => {
    const text = "a".repeat(3000);
    const chunks = splitMessage(text);
    assertEquals(chunks.length, 2);
    assertEquals(chunks[0].length, 2000);
    assertEquals(chunks[1].length, 1000);
  });

  await t.step("カスタム制限値で分割できること", () => {
    const chunks = splitMessage("abcdef", 3);
    assertEquals(chunks, ["abc", "def"]);
  });

  await t.step("空文字列は空配列を返すこと", () => {
    assertEquals(splitMessage(""), []);
  });

  await t.step("非常に長いテキストは複数チャンクに分割すること", () => {
    const text = "a".repeat(5000);
    const chunks = splitMessage(text);
    assertEquals(chunks.length, 3);
    assertEquals(chunks[0].length, 2000);
    assertEquals(chunks[1].length, 2000);
    assertEquals(chunks[2].length, 1000);
  });

  await t.step("後半の改行位置で分割すること", () => {
    const text = "a".repeat(1200) + "\n" + "b".repeat(900);
    const chunks = splitMessage(text);
    assertEquals(chunks.length, 2);
    assertEquals(chunks[0], "a".repeat(1200));
    assertEquals(chunks[1], "b".repeat(900));
  });

  await t.step("前半の改行は無視して強制分割すること", () => {
    const text = "a".repeat(100) + "\n" + "b".repeat(2500);
    const chunks = splitMessage(text);
    assertEquals(chunks[0].length, 2000);
  });
});

Deno.test("keepTyping", async (t) => {
  await t.step("初回の sendTyping が即座に呼ばれること", () => {
    let typingCount = 0;
    const fakeChannel = {
      sendTyping: () => {
        typingCount++;
        return Promise.resolve();
      },
    };

    const controller = new AbortController();
    keepTyping(
      fakeChannel as unknown as import("discord.js").GuildTextBasedChannel,
      controller.signal,
    );

    assertEquals(typingCount, 1);
    controller.abort();
  });

  await t.step("既に abort 済みの場合は何もしないこと", () => {
    let typingCount = 0;
    const fakeChannel = {
      sendTyping: () => {
        typingCount++;
        return Promise.resolve();
      },
    };

    const controller = new AbortController();
    controller.abort();
    keepTyping(
      fakeChannel as unknown as import("discord.js").GuildTextBasedChannel,
      controller.signal,
    );

    assertEquals(typingCount, 0);
  });
});

/** send/edit/delete を記録するフェイクチャンネルを生成する。 */
function fakeProgressChannel() {
  const calls: { method: string; text: string }[] = [];
  const fakeMessage = {
    edit: (text: string) => {
      calls.push({ method: "edit", text });
      return Promise.resolve(fakeMessage);
    },
    delete: () => {
      calls.push({ method: "delete", text: "" });
      return Promise.resolve(fakeMessage);
    },
  };
  const channel = {
    send: (text: string) => {
      calls.push({ method: "send", text });
      return Promise.resolve(fakeMessage);
    },
  } as unknown as GuildTextBasedChannel;

  return { channel, calls };
}

Deno.test("createProgressReporter", async (t) => {
  await t.step("初回の report で send が呼ばれること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Bash", 5);

    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, "send");
    assertEquals(calls[0].text, "`Bash` 実行中... (5s)");

    await cleanup();
  });

  await t.step("2回目の report で edit が呼ばれること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Bash", 1);
    // スロットルを回避するために時間を進める
    // PROGRESS_THROTTLE_MS は 3000ms だが内部状態を直接操作できないので、
    // Date.now をスタブする
    const original = Date.now;
    try {
      Date.now = () => original() + 4000;
      await report("Bash", 5);
    } finally {
      Date.now = original;
    }

    assertEquals(calls.length, 2);
    assertEquals(calls[0].method, "send");
    assertEquals(calls[1].method, "edit");
    assertEquals(calls[1].text, "`Bash` 実行中... (5s)");

    await cleanup();
  });

  await t.step("スロットル間隔内の report は無視されること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Bash", 1);
    await report("Bash", 2);
    await report("Bash", 3);

    assertEquals(calls.length, 1);

    await cleanup();
  });

  await t.step("cleanup で delete が呼ばれること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Read", 3);
    await cleanup();

    assertEquals(calls[calls.length - 1].method, "delete");
  });

  await t.step(
    "report 未呼び出しで cleanup しても delete されないこと",
    async () => {
      const { channel, calls } = fakeProgressChannel();
      const { cleanup } = createProgressReporter(channel);

      await cleanup();

      assertEquals(calls.length, 0);
    },
  );
});
