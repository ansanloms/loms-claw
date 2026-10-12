import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { replaceTemplateVariables } from "./template.ts";

describe("replaceTemplateVariables", () => {
  test("単一のプレースホルダーを置換すること", () => {
    const result = replaceTemplateVariables("Hello {{name}}", {
      name: "world",
    });
    assert.deepStrictEqual(result, "Hello world");
  });

  test("複数のプレースホルダーを置換すること", () => {
    const result = replaceTemplateVariables("{{greeting}} {{name}}", {
      greeting: "Hi",
      name: "loms",
    });
    assert.deepStrictEqual(result, "Hi loms");
  });

  test("ドット記法のキーを置換すること", () => {
    const result = replaceTemplateVariables(
      "Channel: {{discord.channel.name}} ({{discord.channel.id}})",
      { "discord.channel.name": "general", "discord.channel.id": "123" },
    );
    assert.deepStrictEqual(result, "Channel: general (123)");
  });

  test("未定義のキーはそのまま残ること", () => {
    const result = replaceTemplateVariables("{{known}} and {{unknown}}", {
      known: "yes",
    });
    assert.deepStrictEqual(result, "yes and {{unknown}}");
  });

  test("プレースホルダーがない場合はそのまま返すこと", () => {
    const result = replaceTemplateVariables("no placeholders", { a: "b" });
    assert.deepStrictEqual(result, "no placeholders");
  });

  test("空文字列への置換ができること", () => {
    const result = replaceTemplateVariables("prefix {{empty}} suffix", {
      empty: "",
    });
    assert.deepStrictEqual(result, "prefix  suffix");
  });

  test("同じキーの複数出現をすべて置換すること", () => {
    const result = replaceTemplateVariables("{{id}} and {{id}}", { id: "42" });
    assert.deepStrictEqual(result, "42 and 42");
  });
});
