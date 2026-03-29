import { assertEquals } from "@std/assert";
import { keepTyping, splitMessage } from "./message.ts";

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

  await t.step("空文字列はそのまま返すこと", () => {
    assertEquals(splitMessage(""), [""]);
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
