import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchDeleteBody } from "./batch-delete.ts";

test("buildBatchDeleteBody: names 配列をそのまま { names } に包む", () => {
  assert.deepEqual(buildBatchDeleteBody(["a", "b"]), { names: ["a", "b"] });
});

test("buildBatchDeleteBody: 空配列も許容する", () => {
  assert.deepEqual(buildBatchDeleteBody([]), { names: [] });
});
