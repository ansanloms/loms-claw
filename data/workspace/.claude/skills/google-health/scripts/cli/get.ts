import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import { API_BASE, request } from "../lib/api.ts";

const command = define({
  name: "get",
  description:
    "Google Health API の dataPoint 1 件 (GET <name>) を取得し、応答をそのまま標準出力へ出す",
  args: {},
  run: async (ctx) => {
    const name = ctx.positionals[0];
    if (name === undefined) {
      console.error(
        "usage: get <dataPoint name> (例: users/me/dataTypes/steps/dataPoints/<id>)",
      );
      Deno.exit(1);
    }

    try {
      const config = loadTokenConfig();
      const token = await getValidToken(config);
      const url = `${API_BASE}/${name}`;
      const text = await request(url, token.access_token, "GET", undefined);
      console.log(text);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
