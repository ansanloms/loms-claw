// 旧 Deno KV (storePath) の全エントリを JSON で標準出力へ書き出す (Deno 専用)。
// scripts/import-kv.ts (Node) が取り込む。
// <kv path> は data/config.json の storePath が指すファイル (docs/architecture/deployment.md の移行節を参照)。
//
// 実行例:
//   deno run --unstable-kv --allow-read --allow-write scripts/dump-kv.ts /data/workspace/loms-claw.kv > kv-dump.json

const path = Deno.args[0];
if (!path) {
  console.error("usage: dump-kv.ts <kv path>");
  Deno.exit(1);
}

const kv = await Deno.openKv(path);
const entries: { key: Deno.KvKey; value: unknown }[] = [];
for await (const entry of kv.list({ prefix: [] })) {
  entries.push({ key: [...entry.key], value: entry.value });
}
kv.close();

console.log(JSON.stringify(entries, null, 2));
