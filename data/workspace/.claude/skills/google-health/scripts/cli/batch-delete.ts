import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import { buildBatchDeleteBody } from "../lib/batch-delete.ts";
import { checkOperationDone } from "../lib/body.ts";
import { API_BASE, request } from "../lib/api.ts";

const command = define({
  name: "batch-delete",
  description:
    "Google Health API の dataPoints:batchDelete で複数件をまとめて削除する (応答は Operation。response.dataPoints に削除した DataPoint)",
  args: {},
  run: async (ctx) => {
    const dataType = ctx.positionals[0];
    const names = ctx.positionals.slice(1);
    if (dataType === undefined || names.length === 0) {
      console.error("usage: batch-delete <dataType> <dataPoint name...>");
      Deno.exit(1);
    }

    try {
      const config = loadTokenConfig();
      const token = await getValidToken(config);
      const url =
        `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints:batchDelete`;
      const text = await request(
        url,
        token.access_token,
        "POST",
        buildBatchDeleteBody(names),
      );

      console.log(text);
      const warning = checkOperationDone(text);
      if (warning !== undefined) {
        console.error(warning);
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
