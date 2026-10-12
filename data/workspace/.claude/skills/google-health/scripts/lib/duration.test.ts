import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeWindowSize } from "./duration.ts";

test("normalizeWindowSize: 秒はそのまま", () => {
  assert.deepEqual(normalizeWindowSize("30s"), "30s");
});

test("normalizeWindowSize: 分は秒に換算する", () => {
  assert.deepEqual(normalizeWindowSize("5m"), "300s");
});

test("normalizeWindowSize: 時間は秒に換算する", () => {
  assert.deepEqual(normalizeWindowSize("1h"), "3600s");
});

test("normalizeWindowSize: 単位が無い・未対応の単位はエラー", () => {
  assert.throws(() => normalizeWindowSize("5"), /--window/);
  assert.throws(() => normalizeWindowSize("5min"), /--window/);
  assert.throws(() => normalizeWindowSize("5d"), /--window/);
});

test("normalizeWindowSize: 0 秒はどの単位でも拒否する", () => {
  assert.throws(() => normalizeWindowSize("0s"), /0 秒/);
  assert.throws(() => normalizeWindowSize("0m"), /0 秒/);
  assert.throws(() => normalizeWindowSize("0h"), /0 秒/);
});
