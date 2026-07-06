import { assertEquals, assertThrows } from "@std/assert";
import { resolveMunicipality, stripAreaJson } from "./area.ts";

const RAW = {
  offices: { "220000": { name: "静岡県", extra: "落とされる" } },
  class10s: { "220030": { name: "東部", parent: "220000" } },
  class15s: { "220012": { name: "富士山南東", parent: "220030" } },
  class20s: {
    "2220700": { name: "富士宮市", parent: "220012" },
    "2220100": { name: "親の欠けた市", parent: "999999" },
  },
};

Deno.test("stripAreaJson: 必要フィールドのみ残し余分を落とす", () => {
  const data = stripAreaJson(RAW);
  assertEquals(data.offices["220000"], { name: "静岡県", parent: "" });
  assertEquals(data.class10s["220030"], { name: "東部", parent: "220000" });
});

Deno.test("stripAreaJson: セクション欠落は例外 (構造変化)", () => {
  assertThrows(() => stripAreaJson({ offices: {} }), Error, "class10s");
});

Deno.test("resolveMunicipality: class20 → class15 → class10 → office を辿る", () => {
  const matches = resolveMunicipality(stripAreaJson(RAW), "富士宮");
  assertEquals(matches, [
    {
      class20: { code: "2220700", name: "富士宮市" },
      class10: { code: "220030", name: "東部" },
      office: { code: "220000", name: "静岡県" },
    },
  ]);
});

Deno.test("resolveMunicipality: 親の欠けたエントリは候補から除く", () => {
  assertEquals(resolveMunicipality(stripAreaJson(RAW), "親の欠けた"), []);
});

Deno.test("resolveMunicipality: 不一致は空配列", () => {
  assertEquals(resolveMunicipality(stripAreaJson(RAW), "存在しない市"), []);
});
