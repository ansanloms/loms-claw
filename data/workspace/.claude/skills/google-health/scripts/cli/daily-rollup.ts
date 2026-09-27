import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import {
  buildDailyRollupRange,
  checkDailyRollupRangeLimit,
} from "../lib/civil.ts";
import { API_BASE, postPaginated } from "../lib/api.ts";

const command = define({
  name: "daily-rollup",
  description:
    "Google Health API の dataPoints:dailyRollUp を取得し、全ページ結合した JSON を出力する (--to は inclusive)",
  args: {
    from: {
      type: "string",
      description: "取得範囲の開始 (YYYY-MM-DD)",
    },
    to: {
      type: "string",
      description: "取得範囲の終了 (YYYY-MM-DD、inclusive)",
    },
  },
  run: async (ctx) => {
    const dataType = ctx.positionals[0];
    const { from, to } = ctx.values;
    if (dataType === undefined) {
      console.error(
        "usage: daily-rollup <dataType> --from=<YYYY-MM-DD> --to=<YYYY-MM-DD>",
      );
      Deno.exit(1);
    }
    if (from === undefined || to === undefined) {
      console.error("usage: --from と --to は必須");
      Deno.exit(1);
    }

    try {
      const range = buildDailyRollupRange(from, to);
      checkDailyRollupRangeLimit(dataType, range);

      const config = loadTokenConfig();
      const token = await getValidToken(config);

      const url =
        `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`;
      const rollupDataPoints = await postPaginated(
        url,
        token.access_token,
        { range, windowSizeDays: 1 },
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
