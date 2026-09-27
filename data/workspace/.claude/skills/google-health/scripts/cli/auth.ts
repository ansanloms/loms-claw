import { cli, define } from "gunshi";
import { DEFAULT_PORT, loadTokenConfig } from "../lib/config.ts";
import {
  buildAuthUrl,
  DEFAULT_SCOPES,
  exchangeCode as exchangeCodeApi,
  generateState,
} from "../lib/oauth.ts";
import { runAuthServer } from "../lib/auth-server.ts";
import {
  assertTokenPathWritable,
  toStoredToken,
  writeTokenFile,
} from "../lib/token-file.ts";

const command = define({
  name: "auth",
  description:
    "認可 URL を表示し、127.0.0.1:<port> でリダイレクトを待ち受けて認可コードを自動で受信・交換・保存する (ブラウザが実行環境の localhost に届く場合のみ使える。届かない場合は auth-url と token を使う)",
  args: {
    port: {
      type: "number",
      short: "p",
      default: DEFAULT_PORT,
      description:
        `待ち受ける port (既定 ${DEFAULT_PORT})。変える場合は Cloud Console の Authorized redirect URIs も同じ値の http://localhost:<port> に変更しておく`,
    },
    scope: {
      type: "string",
      short: "s",
      multiple: true,
      description:
        "取得スコープ (繰り返し指定可。省略時は activity_and_fitness・health_metrics_and_measurements・sleep・nutrition の readonly/writeonly 計 8 種)",
    },
  },
  run: async (ctx) => {
    const { port, scope } = ctx.values;

    try {
      const config = loadTokenConfig(port);
      await assertTokenPathWritable(config.tokenPath);
      const state = generateState();
      const url = buildAuthUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        scopes: scope !== undefined && scope.length > 0
          ? scope
          : DEFAULT_SCOPES,
        state,
      });
      console.log(url);
      console.error(
        `上記 URL をブラウザで開いて認可すること (${config.redirectUri} への応答を待つ)`,
      );

      const result = await runAuthServer({
        port,
        state,
        exchangeCode: async (code) => {
          const resp = await exchangeCodeApi({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri,
            code,
          });
          const stored = toStoredToken(resp, new Date());
          await writeTokenFile(config.tokenPath, stored);
        },
      });

      if (!result.ok) {
        console.error(result.reason);
        Deno.exit(1);
      }
      console.log(
        JSON.stringify({ token_path: config.tokenPath }, null, 2),
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
