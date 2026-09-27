import { assertEquals, assertThrows } from "@std/assert";
import { checkOperationDone, parseBodyArg } from "./body.ts";

Deno.test("parseBodyArg: JSON オブジェクトの文字列をパースする", () => {
  assertEquals(parseBodyArg('{"foo":"bar"}'), { foo: "bar" });
});

Deno.test("parseBodyArg: JSON として解釈できない文字列はエラー", () => {
  assertThrows(
    () => parseBodyArg("not json"),
    Error,
    "JSON として解釈できない",
  );
});

Deno.test("parseBodyArg: オブジェクトでない JSON (配列・文字列・数値・null) はエラー", () => {
  assertThrows(() => parseBodyArg("[1,2,3]"), Error, "JSON オブジェクト");
  assertThrows(() => parseBodyArg('"str"'), Error, "JSON オブジェクト");
  assertThrows(() => parseBodyArg("123"), Error, "JSON オブジェクト");
  assertThrows(() => parseBodyArg("null"), Error, "JSON オブジェクト");
});

Deno.test("checkOperationDone: done が false なら警告メッセージを返す", () => {
  const msg = checkOperationDone('{"done":false}');
  assertEquals(typeof msg, "string");
});

Deno.test("checkOperationDone: done が true なら undefined", () => {
  assertEquals(checkOperationDone('{"done":true}'), undefined);
});

Deno.test("checkOperationDone: done が true で response があっても undefined (成功)", () => {
  assertEquals(
    checkOperationDone('{"done":true,"response":{"name":"x"}}'),
    undefined,
  );
});

Deno.test("checkOperationDone: error があれば code と message を含む例外 (done の値に関わらず)", () => {
  assertThrows(
    () =>
      checkOperationDone(
        '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ),
    Error,
    "code=500",
  );
  assertThrows(
    () =>
      checkOperationDone(
        '{"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
      ),
    Error,
    "Internal error encountered.",
  );
});

Deno.test("checkOperationDone: done フィールドが無ければ undefined", () => {
  assertEquals(checkOperationDone('{"name":"x"}'), undefined);
});

Deno.test("checkOperationDone: JSON として解釈できない応答は undefined (検査を諦める)", () => {
  assertEquals(checkOperationDone("not json"), undefined);
});
