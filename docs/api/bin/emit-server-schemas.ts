/**
 * バンドル済み OpenAPI (JSON) の `components.schemas` を抽出し、サーバが
 * import できる TypeScript モジュールとして書き出す。
 *
 * docs/api の OpenAPI を単一ソースとし、サーバ側の「型 (json-schema-to-ts の
 * FromSchema)」と「検証 (@cfworker/json-schema)」を 1 枚の component schema
 * から得るための成果物を生成する。ルートの `npm run generate` から
 * `npm --prefix docs/api run emit-server-schemas -- <出力先>` の形で呼ばれる。
 *
 * 生成物 (api/internal-schemas.ts) は自動生成物のため、ルートの oxlint と
 * oxfmt の対象から外している (ignorePatterns)。ルートの tsconfig の型検査には
 * 含まれる。
 *
 * usage: emit-server-schemas.ts <input api.json> <output .ts>
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: emit-server-schemas.ts <input api.json> <output .ts>");
  process.exit(1);
}

const spec = JSON.parse(await readFile(inputPath, "utf8"));
const schemas = spec?.components?.schemas ?? {};

const header = `// This file was auto-generated from the OpenAPI definition in docs/api.
// Do not make direct changes to the file. Run \`npm run generate\`.
//
// docs/api の component schema (= JSON Schema)。サーバはこれ 1 枚から
// 型 (json-schema-to-ts の FromSchema) と検証 (@cfworker/json-schema) を得る。
`;

const body = `export const internalSchemas = ${JSON.stringify(schemas, null, 2)} as const;\n`;

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${header}\n${body}`);
console.log(`emitted: ${outputPath} (${Object.keys(schemas).length} schemas)`);
