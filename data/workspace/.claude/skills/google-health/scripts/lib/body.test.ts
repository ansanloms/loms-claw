import { test } from "node:test";
import assert from "node:assert/strict";
import { checkOperationDone, parseBodyArg } from "./body.ts";

test("parseBodyArg: JSON オブジェクトの文字列をパースする", () => {
  assert.deepEqual(parseBodyArg('{"foo":"bar"}'), { foo: "bar" });
});

test("parseBodyArg: JSON として解釈できない文字列はエラー", () => {
  assert.throws(() => parseBodyArg("not json"), /JSON として解釈できない/);
});

test("parseBodyArg: オブジェクトでない JSON (配列・文字列・数値・null) はエラー", () => {
  assert.throws(() => parseBodyArg("[1,2,3]"), /JSON オブジェクト/);
  assert.throws(() => parseBodyArg('"str"'), /JSON オブジェクト/);
  assert.throws(() => parseBodyArg("123"), /JSON オブジェクト/);
  assert.throws(() => parseBodyArg("null"), /JSON オブジェクト/);
});

test("checkOperationDone: done が false なら警告メッセージを返す", () => {
  const msg = checkOperationDone('{"done":false}');
  assert.deepEqual(typeof msg, "string");
});

test("checkOperationDone: done が true なら undefined", () => {
  assert.deepEqual(checkOperationDone('{"done":true}'), undefined);
});

test("checkOperationDone: done が true で response があっても undefined (成功)", () => {
  assert.deepEqual(
    checkOperationDone('{"done":true,"response":{"name":"x"}}'),
    undefined,
  );
});

test("checkOperationDone: error があれば code と message を含む例外 (done の値に関わらず)", () => {
  assert.throws(
    () =>
      checkOperationDone(
        '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ),
    /code=500/,
  );
  assert.throws(
    () =>
      checkOperationDone(
        '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ),
    /Internal error encountered\./,
  );
});

test("checkOperationDone: done フィールドが無ければ undefined", () => {
  assert.deepEqual(checkOperationDone('{"name":"x"}'), undefined);
});

test("checkOperationDone: JSON として解釈できない応答は undefined (検査を諦める)", () => {
  assert.deepEqual(checkOperationDone("not json"), undefined);
});
