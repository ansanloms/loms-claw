import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import { buildFilter, DATA_TYPE_FILTER_FIELDS } from "../lib/filter.ts";
import { API_BASE, getPaginated } from "../lib/api.ts";

const command = define({
  name: "datapoints",
  description:
    "Google Health API の dataPoints (または --reconcile 指定時は dataPoints:reconcile) を取得し、全ページ結合した JSON を出力する",
  args: {
    from: {
      type: "string",
      description:
        "取得範囲の開始 (YYYY-MM-DD または RFC3339。heart-rate・weight・body-fat は RFC3339 のみ、exercise・nutrition-log は YYYY-MM-DD のみ。sleep は起床時刻 (interval の終端) 基準で切られる)",
    },
    to: {
      type: "string",
      description:
        "取得範囲の終了 (YYYY-MM-DD または RFC3339。heart-rate・weight・body-fat は RFC3339 のみ、exercise・nutrition-log は YYYY-MM-DD のみ。sleep は起床時刻 (interval の終端) 基準で切られる)",
    },
    reconcile: {
      type: "boolean",
      default: false,
      description:
        "dataPoints:reconcile (dataSourceFamily=google-wearables) を使う。google-wearables (Fitbit・Pixel Watch) 由来のデータだけをマージする。Health Connect 由来の型 (weight・body-fat) では空になるので付けない",
    },
    filter: {
      type: "string",
      description:
        "AIP-160 の filter 文字列を生指定する (--from/--to の代わり。同時指定はエラー)。表に無い dataType でも使える (その場合 pageSize は付けない)",
    },
  },
  run: async (ctx) => {
    const dataType = ctx.positionals[0];
    const { from, to, reconcile, filter: rawFilter } = ctx.values;
    if (dataType === undefined) {
      console.error(
        `usage: datapoints <${
          Object.keys(DATA_TYPE_FILTER_FIELDS).join("|")
        }|...> (--from=<...> --to=<...> | --filter=<AIP-160>) [--reconcile]`,
      );
      Deno.exit(1);
    }
    const known = Object.hasOwn(DATA_TYPE_FILTER_FIELDS, dataType);
    if (rawFilter === undefined && !known) {
      console.error(
        `usage: 表に無い dataType (${dataType}) は --filter (AIP-160) を指定する (対応表: ${
          Object.keys(DATA_TYPE_FILTER_FIELDS).join(", ")
        })`,
      );
      Deno.exit(1);
    }
    if (rawFilter !== undefined && (from !== undefined || to !== undefined)) {
      console.error("usage: --filter と --from/--to は同時に指定できない");
      Deno.exit(1);
    }

    try {
      let filter: string;
      if (rawFilter !== undefined) {
        filter = rawFilter;
      } else {
        if (from === undefined || to === undefined) {
          console.error("usage: --from と --to は必須 (--filter 指定時は不要)");
          Deno.exit(1);
        }
        filter = buildFilter(dataType, from, to);
      }
      const config = loadTokenConfig();
      const token = await getValidToken(config);

      const url = new URL(
        reconcile
          ? `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints:reconcile`
          : `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints`,
      );
      url.searchParams.set("filter", filter);
      // dataPoints:reconcile も dataPoints (list) と同じ pageSize を受理する
      // (2026-09-26 実測: sleep に pageSize=25、steps・heart-rate に pageSize=10000 で
      // HTTP 200、件数も list と整合)。表に無い dataType (--filter 生指定時) は pageSize を付けない。
      if (known) {
        url.searchParams.set(
          "pageSize",
          String(DATA_TYPE_FILTER_FIELDS[dataType].pageSize),
        );
      }
      if (reconcile) {
        url.searchParams.set(
          "dataSourceFamily",
          "users/me/dataSourceFamilies/google-wearables",
        );
      }

      const dataPoints = await getPaginated(
        url.toString(),
        token.access_token,
        "dataPoints",
      );
      console.log(JSON.stringify({ dataPoints }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
