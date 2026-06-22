/**
 * `config.json` の JSON Schema バリデータ。
 *
 * schema 本体は {@link config.schema.json} に外出しされており、
 * ここでは @cfworker/json-schema の {@link Validator} へ渡して検証する。
 *
 * @cfworker は副作用を持たない純粋なバリデータで、ajv の `useDefaults` のように
 * 検証と同時に `default` を埋める機能は無い。そのため schema の `default` 補完は
 * {@link applyConfigDefaults} に切り出し、検証前に呼び出す（schema を単一ソースに
 * 保ったまま ajv の `useDefaults: true` と同等の挙動を再現する）。
 *
 * `additionalProperties: false` で未知キーを拒否する（typo の早期検出）。
 *
 * `claude.cwd` はプロセス由来のため schema には含めず、
 * {@link loadConfig} が検証後に `Deno.cwd()` を注入する。
 *
 * `config.json` 側で `"$schema": "./config.schema.json"` を書けば
 * IDE が schema に基づいた補完・検証を行う。
 */

import { type OutputUnit, type Schema, Validator } from "@cfworker/json-schema";
import schema from "./config.schema.json" with { type: "json" };

/**
 * default 補完のために走査する schema ノードの最小形。
 * `properties` を辿りながら各プロパティの `default` を適用する。
 */
interface SchemaNode {
  properties?: Record<string, SchemaNode>;
  default?: unknown;
}

// config.schema.json は draft-07。shortCircuit を false にして全エラーを収集する
// （ajv の allErrors: true 相当）。
const validator = new Validator(schema as unknown as Schema, "7", false);

/**
 * schema の `default` を value へ再帰的に補完する（ajv の `useDefaults: true` 相当）。
 *
 * オブジェクトスキーマの各プロパティについて、value に未定義なら `default` を
 * deep clone して設定し、その後ネストしたプロパティへ再帰する。親オブジェクトの
 * `default: {}` を先に埋めてから子の `default` を適用するため、ネストした既定値も
 * 連鎖的に補完される。value は破壊的に変更される。
 */
function applyDefaults(node: SchemaNode, value: unknown): void {
  const props = node.properties;
  if (
    props === undefined || typeof value !== "object" || value === null ||
    Array.isArray(value)
  ) {
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const [key, propSchema] of Object.entries(props)) {
    if (obj[key] === undefined && "default" in propSchema) {
      obj[key] = structuredClone(propSchema.default);
    }
    if (obj[key] !== undefined) {
      applyDefaults(propSchema, obj[key]);
    }
  }
}

/**
 * `config.json` 由来の値へ schema の `default` を補完する（破壊的変更）。
 */
export function applyConfigDefaults(value: unknown): void {
  applyDefaults(schema as unknown as SchemaNode, value);
}

/**
 * `config.json` 由来の値を schema で構造検証する。
 */
export function validateConfigFile(
  value: unknown,
): { valid: boolean; errors: OutputUnit[] } {
  return validator.validate(value);
}

/**
 * @cfworker のエラー配列を人間が読みやすいメッセージに整形する。
 * 各エラーを `<instanceLocation>: <error>` の形に揃えて 1 行ずつ並べる。
 */
export function formatConfigErrors(
  errors: OutputUnit[] | null | undefined,
): string {
  if (!errors || errors.length === 0) {
    return "(no error details)";
  }

  return errors
    .map((err) => {
      const path = err.instanceLocation && err.instanceLocation !== "#"
        ? err.instanceLocation
        : "(root)";
      return `  - ${path}: ${err.error}`;
    })
    .join("\n");
}
