/**
 * `config.json` の JSON Schema バリデータ。
 *
 * schema 本体は {@link config.schema.json} に外出しされており、
 * ここでは ajv へ渡して型ガード関数 {@link validateConfigFile} を生成するだけ。
 *
 * `useDefaults: true` により、省略されたフィールドは schema の `default` で
 * 自動補完される。`additionalProperties: false` で未知キーを拒否する
 * （typo の早期検出）。
 *
 * `claude.cwd` はプロセス由来のため schema には含めず、
 * {@link loadConfig} が検証後に `Deno.cwd()` を注入する。
 *
 * `config.json` 側で `"$schema": "./config.schema.json"` を書けば
 * IDE が schema に基づいた補完・検証を行う。
 */

import Ajv from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { ConfigFile } from "./config.ts";
import schema from "./config.schema.json" with { type: "json" };

// deno の npm 互換レイヤーでは CJS default export のコンストラクタ型が解決できない
// @ts-expect-error: Ajv CJS default export
const ajv = new Ajv({ allErrors: true, useDefaults: true });

/**
 * `config.json` のバリデータ。
 */
export const validateConfigFile: ValidateFunction<ConfigFile> = ajv.compile<
  ConfigFile
>(schema);

/**
 * ajv のエラー配列を人間が読みやすいメッセージに整形する。
 */
export function formatConfigErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) {
    return "(no error details)";
  }

  return errors
    .map((err) => {
      const path = err.instancePath || "(root)";
      if (err.keyword === "required") {
        return `  - ${path}: missing required property "${err.params.missingProperty}"`;
      }
      if (err.keyword === "additionalProperties") {
        return `  - ${path}: unexpected property "${err.params.additionalProperty}"`;
      }
      if (err.keyword === "type") {
        return `  - ${path}: expected ${err.params.type}`;
      }
      if (err.keyword === "enum") {
        const allowed = (err.params.allowedValues as unknown[]).join(" | ");
        return `  - ${path}: must be one of ${allowed}`;
      }
      if (err.keyword === "minLength") {
        return `  - ${path}: must not be empty`;
      }
      if (err.keyword === "anyOf") {
        return `  - ${path}: does not match any allowed shape`;
      }
      return `  - ${path}: ${err.message ?? "validation error"}`;
    })
    .join("\n");
}
