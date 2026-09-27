import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import { normalizeWindowSize } from "../lib/duration.ts";
import { validateRfc3339Range } from "../lib/filter.ts";
import { API_BASE, postPaginated } from "../lib/api.ts";

const command = define({
  name: "rollup",
  description:
    "Google Health API の dataPoints:rollUp を取得し、全ページ結合した JSON を出力する",
  args: {
    from: {
      type: "string",
      description: "取得範囲の開始 (RFC3339)",
    },
    to: {
      type: "string",
      description: "取得範囲の終了 (RFC3339)",
    },
    window: {
      type: "string",
      description:
        "集計単位 (30s / 5m / 1h のように <数値>s|m|h で指定する。API へは秒に正規化した <秒>s で送る)",
    },
  },
  run: async (ctx) => {
    const dataType = ctx.positionals[0];
    const { from, to, window } = ctx.values;
    if (dataType === undefined) {
      console.error(
        "usage: rollup <dataType> --from=<RFC3339> --to=<RFC3339> --window=<30s|5m|1h>",
      );
      Deno.exit(1);
    }
    if (from === undefined || to === undefined || window === undefined) {
      console.error("usage: --from・--to・--window は必須");
      Deno.exit(1);
    }

    try {
      validateRfc3339Range(from, to);
      const windowSize = normalizeWindowSize(window);
      const config = loadTokenConfig();
      const token = await getValidToken(config);

      const url =
        `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints:rollUp`;
      const rollupDataPoints = await postPaginated(
        url,
        token.access_token,
        { range: { startTime: from, endTime: to }, windowSize },
        "rollupDataPoints",
      );
      console.log(JSON.stringify({ rollupDataPoints }));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
