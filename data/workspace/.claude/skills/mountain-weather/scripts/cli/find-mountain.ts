import { cli, define } from "gunshi";
import {
  BA_LIST,
  type MountainEntry,
  parseKasel,
  prefectureOf,
  searchMountains,
} from "./kasel.ts";

const BASE = "https://tenkura.n-kishou.co.jp/tk/kanko/kasel.html";
const UA = "Mozilla/5.0";
const TYPE = "15"; // 登山カテゴリ固定

/** キャッシュの置き場所 (skill 内 assets/。コミットして配布する)。 */
const ASSET_URL = new URL(
  "../../assets/tenkura-mountains.json",
  import.meta.url,
);

type Asset = {
  fetchedAt: string;
  source: string;
  entries: MountainEntry[];
};

/** Shift_JIS の kasel.html を取得し UTF-8 文字列にデコードする。 */
async function fetchDecoded(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Cache-Control": "no-cache" },
  });
  if (!res.ok) {
    throw new Error(`取得失敗 (HTTP ${res.status}): ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new TextDecoder("shift-jis").decode(buf);
}

/** 全地域の kasel.html を取得・検証し、キャッシュを書き直す。 */
async function updateAsset(): Promise<Asset> {
  const entries: MountainEntry[] = [];
  for (const ba of BA_LIST) {
    const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const html = await fetchDecoded(`${BASE}?ba=${ba}&type=${TYPE}&_=${nonce}`);
    entries.push(...parseKasel(html, ba));
  }
  const asset: Asset = {
    fetchedAt: new Date().toISOString(),
    source: `${BASE}?ba=<ba>&type=${TYPE}`,
    entries,
  };
  await Deno.writeTextFile(ASSET_URL, JSON.stringify(asset, null, 2) + "\n");
  return asset;
}

async function readAsset(): Promise<Asset> {
  try {
    return JSON.parse(await Deno.readTextFile(ASSET_URL)) as Asset;
  } catch {
    throw new Error(
      "キャッシュ (assets/tenkura-mountains.json) が読めない。--update で生成する。",
    );
  }
}

const command = define({
  name: "find-mountain",
  description:
    "てんくらの山リストのキャッシュから山名で code を検索する (--update でキャッシュを取り直す)",
  args: {
    name: {
      type: "string",
      short: "n",
      description: "山名 (部分一致)",
    },
    update: {
      type: "boolean",
      short: "u",
      default: false,
      description: "全地域の kasel.html を取得しキャッシュを書き直す",
    },
  },
  run: async (ctx) => {
    const { name, update } = ctx.values;

    if (name === undefined && !update) {
      console.error(
        "usage: find-mountain --name=<山名> [--update] | find-mountain --update",
      );
      Deno.exit(1);
    }

    try {
      const asset = update ? await updateAsset() : await readAsset();

      if (name === undefined) {
        console.log(
          JSON.stringify(
            {
              updated: true,
              fetchedAt: asset.fetchedAt,
              count: asset.entries.length,
            },
            null,
            2,
          ),
        );
        return;
      }

      const matches = searchMountains(asset.entries, name).map((e) => ({
        ...e,
        pref: prefectureOf(e.code),
      }));

      if (matches.length === 0 && !update) {
        console.error(
          `「${name}」が 0 件。キャッシュ (${asset.fetchedAt} 取得) が古い可能性がある。--update を付けて取り直してから再判断する。`,
        );
        Deno.exit(1);
      }

      console.log(
        JSON.stringify(
          { query: name, fetchedAt: asset.fetchedAt, matches },
          null,
          2,
        ),
      );
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
