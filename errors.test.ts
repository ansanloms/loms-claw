import { describe, test } from "node:test";
import { assertEquals } from "@std/assert";
import { getErrorMessage, summarizeErrorForDiscord } from "./errors.ts";

describe("getErrorMessage", () => {
  test("Error インスタンスの message を返すこと", () => {
    assertEquals(getErrorMessage(new Error("boom")), "boom");
  });

  test("Error 以外の値は String() で文字列化されること", () => {
    assertEquals(getErrorMessage("plain string"), "plain string");
    assertEquals(getErrorMessage(42), "42");
  });
});

describe("summarizeErrorForDiscord", () => {
  test("単一行の短いメッセージがそのまま含まれること", () => {
    const result = summarizeErrorForDiscord(new Error("boom"));
    assertEquals(
      result,
      "処理に失敗した。詳細はログ (`GET /logs`) を参照\nboom",
    );
  });

  test("複数行メッセージは先頭 1 行だけが使われること", () => {
    const result = summarizeErrorForDiscord(
      new Error("first line\nsecond line\nthird line"),
    );
    assertEquals(
      result,
      "処理に失敗した。詳細はログ (`GET /logs`) を参照\nfirst line",
    );
  });

  test("200 文字を超える先頭行は 200 文字に切られること", () => {
    const longLine = "a".repeat(250);
    const result = summarizeErrorForDiscord(new Error(longLine));
    const [, summarizedLine] = result.split("\n");
    assertEquals(summarizedLine.length, 200);
    assertEquals(summarizedLine, "a".repeat(200));
  });

  test("Error 以外の値でも要約されること", () => {
    const result = summarizeErrorForDiscord("plain error value");
    assertEquals(
      result,
      "処理に失敗した。詳細はログ (`GET /logs`) を参照\nplain error value",
    );
  });
});
