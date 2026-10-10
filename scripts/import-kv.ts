// scripts/dump-kv.ts のダンプ JSON を SQLite の store へ取り込む。
//
// 実行例:
//   node scripts/import-kv.ts kv-dump.json /data/workspace/loms-claw.sqlite

import { readFileSync } from "node:fs";
import { isRecord } from "../guards.ts";
import { openStoreDatabase, Store } from "../store/mod.ts";

interface SettingEntry {
  id: string;
  field: string;
  value: string;
}

/** `["channel", id, field]` -> string の形のエントリだけを取り出す。 */
function toSettingEntry(entry: unknown): SettingEntry | undefined {
  if (!isRecord(entry)) {
    return undefined;
  }
  const { key, value } = entry;
  if (
    Array.isArray(key) &&
    key.length === 3 &&
    key[0] === "channel" &&
    typeof key[1] === "string" &&
    typeof key[2] === "string" &&
    typeof value === "string"
  ) {
    return { id: key[1], field: key[2], value };
  }
  return undefined;
}

const [dumpPath, sqlitePath] = process.argv.slice(2);
if (!dumpPath || !sqlitePath) {
  console.error("usage: import-kv.ts <dump json> <sqlite path>");
  process.exit(1);
}

const dump: unknown = JSON.parse(readFileSync(dumpPath, "utf8"));
if (!Array.isArray(dump)) {
  console.error("dump must be a JSON array");
  process.exit(1);
}

const db = openStoreDatabase(sqlitePath);
// テーブル作成は Store に任せる (スキーマを二重定義しない)。
new Store(db);

const upsert = db.prepare(
  `INSERT INTO settings (id, field, value) VALUES ($id, $field, $value)
   ON CONFLICT(id, field) DO UPDATE SET value = excluded.value`,
);

let imported = 0;
let skipped = 0;
db.exec("BEGIN");
try {
  for (const entry of dump) {
    const setting = toSettingEntry(entry);
    if (setting === undefined) {
      const key = isRecord(entry) ? JSON.stringify(entry.key) : String(entry);
      console.error(`skipped: ${key}`);
      skipped++;
      continue;
    }
    upsert.run({ ...setting });
    imported++;
  }
  db.exec("COMMIT");
} catch (e) {
  if (db.isTransaction) {
    db.exec("ROLLBACK");
  }
  throw e;
}

db.close();
console.log(`imported ${imported} entries, skipped ${skipped} entries`);
