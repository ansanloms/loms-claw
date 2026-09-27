import { assertEquals, assertThrows } from "@std/assert";
import { normalizeWindowSize } from "./duration.ts";

Deno.test("normalizeWindowSize: 秒はそのまま", () => {
  assertEquals(normalizeWindowSize("30s"), "30s");
});

Deno.test("normalizeWindowSize: 分は秒に換算する", () => {
  assertEquals(normalizeWindowSize("5m"), "300s");
});

Deno.test("normalizeWindowSize: 時間は秒に換算する", () => {
  assertEquals(normalizeWindowSize("1h"), "3600s");
});

Deno.test("normalizeWindowSize: 単位が無い・未対応の単位はエラー", () => {
  assertThrows(() => normalizeWindowSize("5"), Error, "--window");
  assertThrows(() => normalizeWindowSize("5min"), Error, "--window");
  assertThrows(() => normalizeWindowSize("5d"), Error, "--window");
});

Deno.test("normalizeWindowSize: 0 秒はどの単位でも拒否する", () => {
  assertThrows(() => normalizeWindowSize("0s"), Error, "0 秒");
  assertThrows(() => normalizeWindowSize("0m"), Error, "0 秒");
  assertThrows(() => normalizeWindowSize("0h"), Error, "0 秒");
});
