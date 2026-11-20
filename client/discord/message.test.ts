import { describe, test } from "node:test";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { GuildTextBasedChannel } from "discord.js";
import {
  appendImageReferences,
  cleanupImageFiles,
  createProgressReporter,
  runTurnCleanup,
  type DownloadedImage,
  keepTyping,
  splitMessage,
  stripBotMentions,
} from "./message.ts";

describe("splitMessage", () => {
  test("短いテキストは 1 チャンクで返すこと", () => {
    assert.deepStrictEqual(splitMessage("hello"), ["hello"]);
  });

  test("制限値ちょうどのテキストは 1 チャンクで返すこと", () => {
    const text = "a".repeat(2000);
    assert.deepStrictEqual(splitMessage(text), [text]);
  });

  test("改行位置で分割すること", () => {
    const line1 = "a".repeat(1500);
    const line2 = "b".repeat(600);
    const text = `${line1}\n${line2}`;
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0], line1);
    assert.deepStrictEqual(chunks[1], line2);
  });

  test("後半に改行がない場合は強制分割すること", () => {
    const text = "a".repeat(3000);
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0].length, 2000);
    assert.deepStrictEqual(chunks[1].length, 1000);
  });

  test("カスタム制限値で分割できること", () => {
    const chunks = splitMessage("abcdef", 3);
    assert.deepStrictEqual(chunks, ["abc", "def"]);
  });

  test("空文字列は空配列を返すこと", () => {
    assert.deepStrictEqual(splitMessage(""), []);
  });

  test("非常に長いテキストは複数チャンクに分割すること", () => {
    const text = "a".repeat(5000);
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks.length, 3);
    assert.deepStrictEqual(chunks[0].length, 2000);
    assert.deepStrictEqual(chunks[1].length, 2000);
    assert.deepStrictEqual(chunks[2].length, 1000);
  });

  test("後半の改行位置で分割すること", () => {
    const text = "a".repeat(1200) + "\n" + "b".repeat(900);
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0], "a".repeat(1200));
    assert.deepStrictEqual(chunks[1], "b".repeat(900));
  });

  test("前半の改行は無視して強制分割すること", () => {
    const text = "a".repeat(100) + "\n" + "b".repeat(2500);
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks[0].length, 2000);
  });

  test("制限値 +1 文字のテキストは 2 チャンクに分割すること", () => {
    const text = "a".repeat(2001);
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks.length, 2);
    assert.deepStrictEqual(chunks[0].length, 2000);
    assert.deepStrictEqual(chunks[1].length, 1);
  });

  test("コードフェンスをまたぐ場合は境界を考慮せず改行位置で分割すること（既存仕様）", () => {
    const before = "a".repeat(1990);
    const text = `${before}\n\`\`\`\n${"b".repeat(500)}\n\`\`\``;
    const chunks = splitMessage(text);
    assert.deepStrictEqual(chunks.length, 2);
    // 改行位置優先のため、コードフェンスの開始行の直後で分割される
    assert.deepStrictEqual(chunks[0], `${before}\n\`\`\``);
    assert.deepStrictEqual(chunks[1], `${"b".repeat(500)}\n\`\`\``);
  });
});

describe("keepTyping", () => {
  test("初回の sendTyping が即座に呼ばれること", () => {
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

    assert.deepStrictEqual(typingCount, 1);
    controller.abort();
  });

  test("既に abort 済みの場合は何もしないこと", () => {
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

    assert.deepStrictEqual(typingCount, 0);
  });
});

/** send/edit/delete を記録するフェイクチャンネルを生成する。 */
function fakeProgressChannel(
  options: { failFirstSend?: boolean; delaySend?: boolean } = {},
) {
  const calls: { method: string; text: string }[] = [];
  let failNextSend = options.failFirstSend ?? false;
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
  let releaseSend: () => void = () => {};
  const channel = {
    send: (text: string) => {
      if (failNextSend) {
        failNextSend = false;
        return Promise.reject(new Error("send failed"));
      }
      calls.push({ method: "send", text });
      if (options.delaySend) {
        return new Promise((resolve) => {
          releaseSend = () => resolve(fakeMessage);
        });
      }
      return Promise.resolve(fakeMessage);
    },
  } as unknown as GuildTextBasedChannel;

  return { channel, calls, releaseSend: () => releaseSend() };
}

describe("createProgressReporter", () => {
  test("初回の report で send が呼ばれること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Bash", 5);

    assert.deepStrictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].method, "send");
    assert.deepStrictEqual(calls[0].text, "`Bash` 実行中... (5s)");

    await cleanup();
  });

  test("2回目の report で edit が呼ばれること", async () => {
    const { channel, calls } = fakeProgressChannel();
    let fakeNow = 10000;
    const { report, cleanup } = createProgressReporter(channel, () => fakeNow);

    await report("Bash", 1);
    // スロットルを回避するために時間を進める（PROGRESS_THROTTLE_MS = 3000ms）
    fakeNow += 4000;
    await report("Bash", 5);

    assert.deepStrictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[0].method, "send");
    assert.deepStrictEqual(calls[1].method, "edit");
    assert.deepStrictEqual(calls[1].text, "`Bash` 実行中... (5s)");

    await cleanup();
  });

  test("スロットル間隔内の report は無視されること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Bash", 1);
    await report("Bash", 2);
    await report("Bash", 3);

    assert.deepStrictEqual(calls.length, 1);

    await cleanup();
  });

  test("cleanup で delete が呼ばれること", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await report("Read", 3);
    await cleanup();

    assert.deepStrictEqual(calls[calls.length - 1].method, "delete");
  });

  test("report 未呼び出しで cleanup しても delete されないこと", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { cleanup } = createProgressReporter(channel);

    await cleanup();

    assert.deepStrictEqual(calls.length, 0);
  });

  test("初回 send が reject しても report が reject せず、間引き間隔の後の report で再送されること", async () => {
    const { channel, calls } = fakeProgressChannel({ failFirstSend: true });
    let fakeNow = 10000;
    const { report, cleanup } = createProgressReporter(channel, () => fakeNow);

    await report("Bash", 1);
    assert.deepStrictEqual(calls.length, 0);

    // 失敗後も間引きは保たれるので、間隔内の report では送られない
    fakeNow += 1000;
    await report("Bash", 2);
    assert.deepStrictEqual(calls.length, 0);

    fakeNow += 4000;
    await report("Bash", 5);
    assert.deepStrictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].method, "send");

    await cleanup();
  });

  test("初回 send の待機中に cleanup しても、後から届いたメッセージが削除されること", async () => {
    const { channel, calls, releaseSend } = fakeProgressChannel({
      delaySend: true,
    });
    const { report, cleanup } = createProgressReporter(channel);

    const reporting = report("Bash", 1);
    await cleanup();
    releaseSend();
    await reporting;

    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["send", "delete"],
    );
  });

  test("初回 send の待機中は、間引きを超えた次の report でも二重に send しないこと", async () => {
    const { channel, calls, releaseSend } = fakeProgressChannel({
      delaySend: true,
    });
    let fakeNow = 10000;
    const { report, cleanup } = createProgressReporter(channel, () => fakeNow);

    const first = report("Bash", 1);
    fakeNow += 4000;
    await report("Bash", 5);
    releaseSend();
    await first;

    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["send"],
    );

    await cleanup();
  });

  test("送信の待機中に捨てた report は間引きの時刻を進めないこと", async () => {
    const { channel, calls, releaseSend } = fakeProgressChannel({
      delaySend: true,
    });
    let fakeNow = 10000;
    const { report, cleanup } = createProgressReporter(channel, () => fakeNow);

    const first = report("Bash", 1);
    // 待機中に間引きの内側で届いた report は捨てられる。
    fakeNow += 2500;
    await report("Bash", 2);
    releaseSend();
    await first;

    // 最初の report から 3 秒を超えたので、次は edit される (捨てた report に引きずられない)。
    fakeNow += 1000;
    await report("Bash", 3);

    assert.deepStrictEqual(
      calls.map((c) => c.method),
      ["send", "edit"],
    );

    await cleanup();
  });

  test("cleanup 後の report は何もしないこと", async () => {
    const { channel, calls } = fakeProgressChannel();
    const { report, cleanup } = createProgressReporter(channel);

    await cleanup();
    await report("Bash", 1);

    assert.deepStrictEqual(calls.length, 0);
  });
});

describe("appendImageReferences", () => {
  test("画像がない場合はプロンプトがそのまま返ること", () => {
    assert.deepStrictEqual(appendImageReferences("hello", []), "hello");
  });

  test("単一画像の参照が付加されること", () => {
    const images: DownloadedImage[] = [
      { path: "/tmp/test/a.jpg", originalName: "photo.jpg" },
    ];
    const result = appendImageReferences("describe this", images);
    assert.deepStrictEqual(result, "describe this\n\n@/tmp/test/a.jpg");
  });

  test("複数画像の参照がスペース区切りで付加されること", () => {
    const images: DownloadedImage[] = [
      { path: "/tmp/test/a.jpg", originalName: "a.jpg" },
      { path: "/tmp/test/b.png", originalName: "b.png" },
    ];
    const result = appendImageReferences("what are these", images);
    assert.deepStrictEqual(
      result,
      "what are these\n\n@/tmp/test/a.jpg @/tmp/test/b.png",
    );
  });
});

describe("cleanupImageFiles", () => {
  test("一時ディレクトリが削除されること", async () => {
    const dir = await mkdtemp(join(tmpdir(), "loms-claw-test-"));
    const filepath = `${dir}/test.jpg`;
    await writeFile(filepath, "dummy");

    const images: DownloadedImage[] = [
      { path: filepath, originalName: "test.jpg" },
    ];
    await cleanupImageFiles(images);

    await assert.rejects(stat(dir), { code: "ENOENT" });
  });

  test("既に削除済みでもエラーにならないこと", async () => {
    const images: DownloadedImage[] = [
      { path: "/tmp/nonexistent-dir-12345/test.jpg", originalName: "test.jpg" },
    ];
    await cleanupImageFiles(images);
  });
});

describe("stripBotMentions", () => {
  test("表示名のメンションが除去されること", () => {
    assert.deepStrictEqual(
      stripBotMentions("@loms-claw 天気教えて", ["loms-claw"]),
      "天気教えて",
    );
  });

  test("接頭辞関係にある名前でも残骸が残らないこと", () => {
    assert.deepStrictEqual(
      stripBotMentions("@loms-claw 天気教えて", ["loms", "loms-claw"]),
      "天気教えて",
    );
    assert.deepStrictEqual(
      stripBotMentions("@loms-claw 天気教えて", ["loms-claw", "loms"]),
      "天気教えて",
    );
  });

  test("複数箇所のメンションがすべて除去されること", () => {
    assert.deepStrictEqual(
      stripBotMentions("@loms 天気 @loms 教えて", ["loms"]),
      "天気  教えて",
    );
  });

  test("名前が無い・空文字の場合は trim のみ行われること", () => {
    assert.deepStrictEqual(stripBotMentions("  本文  ", []), "本文");
    assert.deepStrictEqual(stripBotMentions("  本文  ", [""]), "本文");
  });
});

describe("runTurnCleanup", () => {
  test("step が throw しても abortTyping が呼ばれ、後続 step も実行されること", async () => {
    const order: string[] = [];
    await runTurnCleanup(
      () => order.push("abort"),
      [
        () => {
          order.push("step1");
          return Promise.reject(new Error("boom"));
        },
        () => {
          order.push("step2");
          return Promise.resolve();
        },
      ],
    );

    assert.deepStrictEqual(order, ["abort", "step1", "step2"]);
  });
});
