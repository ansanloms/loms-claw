import { cli, define } from "gunshi";
import { type AreaData, resolveMunicipality, stripAreaJson } from "./area.ts";

const SOURCE = "https://www.jma.go.jp/bosai/common/const/area.json";

/** キャッシュの置き場所 (skill 内 assets/。コミットして配布する)。 */
const ASSET_URL = new URL("../../assets/jma-area.json", import.meta.url);

type Asset = { fetchedAt: string; source: string } & AreaData;

/** area.json を取得し、必要部分のみに正規化する。 */
async function updateAsset(): Promise<Asset> {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const res = await fetch(`${SOURCE}?_=${nonce}`, {
    headers: { "Cache-Control": "no-cache" },
  });
  if (!res.ok) {
    throw new Error(`取得失敗 (HTTP ${res.status}): ${SOURCE}`);
  }
  const data = stripAreaJson(await res.json());
  const asset: Asset = {
    fetchedAt: new Date().toISOString(),
    source: SOURCE,
    ...data,
  };
  await Deno.writeTextFile(ASSET_URL, JSON.stringify(asset, null, 2) + "\n");
  return asset;
}

async function readAsset(): Promise<Asset> {
  try {
    return JSON.parse(await Deno.readTextFile(ASSET_URL)) as Asset;
  } catch {
    throw new Error(
      "キャッシュ (assets/jma-area.json) が読めない。--update で生成する。",
    );
  }
}

const command = define({
  name: "find-area",
  description:
    "気象庁 area.json のキャッシュから、市町村・地区名で細分区 (class10) と気象台 (office) を検索する",
  args: {
    municipality: {
      type: "string",
      short: "m",
      description:
        "登山口の市町村・地区名 (部分一致。例: 富士宮市、松本市乗鞍上高地)",
    },
    update: {
      type: "boolean",
      short: "u",
      default: false,
      description: "area.json を取得しキャッシュを書き直す",
    },
  },
  run: async (ctx) => {
    const { municipality, update } = ctx.values;

    if (municipality === undefined && !update) {
      console.error(
        "usage: find-area --municipality=<市町村・地区名> [--update] | find-area --update",
      );
      Deno.exit(1);
    }

    try {
      const asset = update ? await updateAsset() : await readAsset();

      if (municipality === undefined) {
        console.log(
          JSON.stringify(
            {
              updated: true,
              fetchedAt: asset.fetchedAt,
              class20Count: Object.keys(asset.class20s).length,
            },
            null,
            2,
          ),
        );
        return;
      }

      const matches = resolveMunicipality(asset, municipality);

      if (matches.length === 0 && !update) {
        console.error(
          `「${municipality}」が 0 件。より広い市名・近隣地名で引き直すか、キャッシュ (${asset.fetchedAt} 取得) が古い可能性があれば --update を付けて取り直す。`,
        );
        Deno.exit(1);
      }

      console.log(
        JSON.stringify(
          { query: municipality, fetchedAt: asset.fetchedAt, matches },
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
