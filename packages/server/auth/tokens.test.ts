import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { describe, test } from "node:test";
import { errorWith } from "../test-helpers.ts";
import { createTokenRegistry, parseUserTokens } from "./tokens.ts";

const sha256 = (token: string) => hash("sha256", token, "hex");

/** `value` を読んで例外が出ること、その message に `value` の断片が含まれないことを確かめる。 */
function assertNoLeak(value: string): void {
  let message: string | undefined;
  try {
    parseUserTokens(value);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.ok(message !== undefined, "例外が投げられること");
  for (const piece of value.split(/[,=]/)) {
    if (piece.trim() !== "") {
      assert.ok(
        !message.includes(piece.trim()),
        `message に ${piece} を含まない`,
      );
    }
  }
}

describe("parseUserTokens", () => {
  test("名前=ハッシュをカンマで区切って読めること", () => {
    const a = sha256("a");
    const b = sha256("b").toUpperCase();
    assert.deepStrictEqual(parseUserTokens(`cli=${a}, discord=${b}`), [
      { name: "cli", hash: a },
      { name: "discord", hash: b.toLowerCase() },
    ]);
  });

  test("未設定と空は例外を投げること", () => {
    assert.throws(
      () => parseUserTokens(undefined),
      errorWith(Error, "未設定または空"),
    );
    assert.throws(
      () => parseUserTokens("  "),
      errorWith(Error, "未設定または空"),
    );
  });

  test("名前が空の項目は例外を投げること", () => {
    assert.throws(
      () => parseUserTokens(`=${sha256("a")}`),
      errorWith(Error, "名前=ハッシュ"),
    );
  });

  test("= の無い項目は例外を投げ、message に値を含めないこと", () => {
    assert.throws(
      () => parseUserTokens("secret-token"),
      errorWith(Error, "1 番目の項目"),
    );
    assertNoLeak("secret-token");
  });

  test("= を含む平文の token は message に含まれないこと", () => {
    const plain = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/AbCdEfGh=";
    assertNoLeak(plain);
    assertNoLeak(`${plain},${plain}`);
    assertNoLeak(`cli=${sha256("a")},${plain}`);
  });

  test("ハッシュが 64 桁の hex でない項目は例外を投げること", () => {
    assert.throws(
      () => parseUserTokens("cli=abc"),
      errorWith(Error, "1 番目の項目のハッシュが 64 桁の hex でない"),
    );
    assert.throws(
      () => parseUserTokens(`cli=${"z".repeat(64)}`),
      errorWith(Error, "1 番目の項目のハッシュが 64 桁の hex でない"),
    );
  });

  test("名前が重複すると例外を投げること", () => {
    const a = sha256("a");
    assert.throws(
      () => parseUserTokens(`cli=${a},cli=${a}`),
      errorWith(Error, "2 番目の項目の名前が重複"),
    );
  });

  test("別の名前で同じハッシュを登録すると例外を投げること", () => {
    const a = sha256("a");
    assert.throws(
      () => parseUserTokens(`cli=${a},discord=${a}`),
      errorWith(Error, "2 番目の項目のハッシュが重複"),
    );
  });

  test("大文字小文字だけが違う同じハッシュも重複として例外を投げること", () => {
    const a = sha256("a");
    assert.throws(
      () => parseUserTokens(`cli=${a},discord=${a.toUpperCase()}`),
      errorWith(Error, "ハッシュが重複"),
    );
  });

  test("= の前後の空白は名前とハッシュから除かれること", () => {
    const a = sha256("a");
    const b = sha256("b");
    assert.deepStrictEqual(parseUserTokens(`cli =${a}`), [
      { name: "cli", hash: a },
    ]);
    assert.deepStrictEqual(parseUserTokens(`cli= ${b}`), [
      { name: "cli", hash: b },
    ]);
  });

  test("空白の有無だけが違う名前も重複として例外を投げること", () => {
    assert.throws(
      () => parseUserTokens(`cli =${sha256("a")},cli=${sha256("b")}`),
      errorWith(Error, "2 番目の項目の名前が重複"),
    );
  });

  test("名前が空白だけの項目は例外を投げること", () => {
    assert.throws(
      () => parseUserTokens(` =${sha256("a")}`),
      errorWith(Error, "名前=ハッシュ"),
    );
  });

  test("末尾のカンマによる空の項目は例外を投げること", () => {
    assert.throws(
      () => parseUserTokens(`cli=${sha256("a")},`),
      errorWith(Error, "名前=ハッシュ"),
    );
  });
});

describe("createTokenRegistry", () => {
  const registry = () =>
    createTokenRegistry(parseUserTokens(`cli=${sha256("user-token")}`));

  test("resolve: 利用者の token が user と client:<名前> に解決されること", () => {
    assert.deepStrictEqual(registry().resolve("user-token"), {
      role: "user",
      source: "client:cli",
    });
  });

  test("resolve: 未知の token は undefined になること", () => {
    assert.deepStrictEqual(registry().resolve("other"), undefined);
  });

  test("issueAgentToken: 発行した一時 token が agent と出所に解決されること", () => {
    const r = registry();
    const token = r.issueAgentToken("turn:t-0001");
    assert.deepStrictEqual(r.resolve(token), {
      role: "agent",
      source: "turn:t-0001",
    });
  });

  test("issueAgentToken: 発行のたびに別の token になること", () => {
    const r = registry();
    assert.notDeepStrictEqual(r.issueAgentToken("a"), r.issueAgentToken("a"));
  });

  test("revokeAgentToken: 失効した一時 token は解決できないこと", () => {
    const r = registry();
    const token = r.issueAgentToken("turn:t-0001");
    r.revokeAgentToken(token);
    assert.deepStrictEqual(r.resolve(token), undefined);
  });

  test("revokeAgentToken: 未知の token を失効させても例外を投げないこと", () => {
    assert.doesNotThrow(() => registry().revokeAgentToken("unknown"));
  });
});
