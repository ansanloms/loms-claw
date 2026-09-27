import { assertEquals } from "@std/assert";
import { buildBatchDeleteBody } from "./batch-delete.ts";

Deno.test("buildBatchDeleteBody: names 配列をそのまま { names } に包む", () => {
  assertEquals(buildBatchDeleteBody(["a", "b"]), { names: ["a", "b"] });
});

Deno.test("buildBatchDeleteBody: 空配列も許容する", () => {
  assertEquals(buildBatchDeleteBody([]), { names: [] });
});
