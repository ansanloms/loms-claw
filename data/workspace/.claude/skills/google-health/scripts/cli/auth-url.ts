import { cli, define } from "gunshi";
import { DEFAULT_PORT, loadAuthUrlConfig } from "../lib/config.ts";
import { buildAuthUrl, DEFAULT_SCOPES, generateState } from "../lib/oauth.ts";

const command = define({
  name: "auth-url",
  description:
    "Google Health API の認可 URL を組み立てて出力する (auth コマンドが使えない場合の退路。ブラウザで開いて認可コードを取得し、token コマンドへ渡す)",
  args: {
    port: {
      type: "number",
      short: "p",
      default: DEFAULT_PORT,
      description:
        `redirect_uri (http://localhost:<port>) に使う port (既定 ${DEFAULT_PORT})。auth コマンドの --port・token コマンドの --port と揃える`,
    },
    scope: {
      type: "string",
      short: "s",
      multiple: true,
      description:
        "取得スコープ (繰り返し指定可。省略時は activity_and_fitness・health_metrics_and_measurements・sleep・nutrition の readonly/writeonly 計 8 種)",
    },
  },
  run: (ctx) => {
    const { scope, port } = ctx.values;
    try {
      const config = loadAuthUrlConfig(port);
      const state = generateState();
      console.log(
        buildAuthUrl({
          clientId: config.clientId,
          redirectUri: config.redirectUri,
          scopes: scope !== undefined && scope.length > 0
            ? scope
            : DEFAULT_SCOPES,
          state,
        }),
      );
      console.error(`state: ${state}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
