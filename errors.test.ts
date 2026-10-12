import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getErrorMessage, summarizeErrorForDiscord } from "./errors.ts";

describe("getErrorMessage", () => {
  test("Error インスタンスの message を返すこと", () => {
    assert.deepStrictEqual(getErrorMessage(new Error("boom")), "boom");
  });

  test("Error 以外の値は String() で文字列化されること", () => {
    assert.deepStrictEqual(getErrorMessage("plain string"), "plain string");
    assert.deepStrictEqual(getErrorMessage(42), "42");
  });
});

describe("summarizeErrorForDiscord", () => {
  test("単一行の短いメッセージがそのまま含まれること", () => {
    const result = summarizeErrorForDiscord(new Error("boom"));
    assert.deepStrictEqual(
      result,
      "処理に失敗した。詳細はログ (`GET /logs`) を参照\nboom",
    );
  });

  test("複数行メッセージは先頭 1 行だけが使われること", () => {
    const result = summarizeErrorForDiscord(
      new Error("first line\nsecond line\nthird line"),
    );
    assert.deepStrictEqual(
      result,
      "処理に失敗した。詳細はログ (`GET /logs`) を参照\nfirst line",
    );
  });

  test("200 文字を超える先頭行は 200 文字に切られること", () => {
    const longLine = "a".repeat(250);
    const result = summarizeErrorForDiscord(new Error(longLine));
    const [, summarizedLine] = result.split("\n");
    assert.deepStrictEqual(summarizedLine.length, 200);
    assert.deepStrictEqual(summarizedLine, "a".repeat(200));
  });

  test("Error 以外の値でも要約されること", () => {
    const result = summarizeErrorForDiscord("plain error value");
    assert.deepStrictEqual(
      result,
      "処理に失敗した。詳細はログ (`GET /logs`) を参照\nplain error value",
    );
  });
});
