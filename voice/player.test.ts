import { assertEquals } from "@std/assert";
import { splitSentences } from "./player.ts";

Deno.test("splitSentences", async (t) => {
  await t.step("句点で分割すること", () => {
    assertEquals(splitSentences("こんにちは。元気ですか。"), [
      "こんにちは。",
      "元気ですか。",
    ]);
  });

  await t.step("改行で分割すること", () => {
    assertEquals(splitSentences("一行目\n二行目"), [
      "一行目",
      "二行目",
    ]);
  });

  await t.step("句点と改行が混在しても分割すること", () => {
    assertEquals(splitSentences("はい。\nいいえ。"), [
      "はい。",
      "いいえ。",
    ]);
  });

  await t.step("空文字列は空配列を返すこと", () => {
    assertEquals(splitSentences(""), []);
  });

  await t.step("空白のみのセグメントは除外されること", () => {
    assertEquals(splitSentences("テスト。\n\n結果。"), [
      "テスト。",
      "結果。",
    ]);
  });

  await t.step("句点がない文はそのまま 1 要素で返すこと", () => {
    assertEquals(splitSentences("句点なし"), ["句点なし"]);
  });
});
