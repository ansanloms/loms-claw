import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { splitAtBoundary } from "./flush.ts";

describe("splitAtBoundary", () => {
  test("文境界 (。) があればそこで区切ること", () => {
    const result = splitAtBoundary("こんにちは。元気です", 800, false);
    assert.deepStrictEqual(result, { send: "こんにちは。", rest: "元気です" });
  });

  test("文境界 (改行) があればそこで区切ること", () => {
    const result = splitAtBoundary("1行目\n2行目", 800, false);
    assert.deepStrictEqual(result, { send: "1行目", rest: "2行目" });
  });

  test("境界が閾値より後ろにあっても、最後の境界で区切ること", () => {
    const result = splitAtBoundary("a。b。c", 800, false);
    assert.deepStrictEqual(result, { send: "a。b。", rest: "c" });
  });

  test("境界が無く閾値の 2 倍未満なら null (状態変化なし) を返すこと", () => {
    const buffer = "x".repeat(100);
    const result = splitAtBoundary(buffer, 800, false);
    assert.deepStrictEqual(result, null);
  });

  test("境界が無く閾値の 2 倍以上なら強制フラッシュ (全部送る) すること", () => {
    const buffer = "x".repeat(1600);
    const result = splitAtBoundary(buffer, 800, false);
    assert.deepStrictEqual(result, { send: buffer, rest: "" });
  });

  test("force が true なら境界を無視して全部送ること", () => {
    const result = splitAtBoundary("a。b\nc", 800, true);
    assert.deepStrictEqual(result, { send: "a。b\nc", rest: "" });
  });

  test("force で trim 後に空なら send は空文字列になること", () => {
    const result = splitAtBoundary("   \n  ", 800, true);
    assert.deepStrictEqual(result, { send: "", rest: "" });
  });

  test("境界直後までが空白のみでも rest には境界より後ろが反映されること", () => {
    const result = splitAtBoundary("   。 次の文", 800, false);
    assert.deepStrictEqual(result, { send: "。", rest: " 次の文" });
  });
});
