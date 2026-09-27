import { cli, define } from "gunshi";
import { DEFAULT_PORT, loadTokenConfig } from "../lib/config.ts";
import { exchangeCode } from "../lib/oauth.ts";
import {
  assertTokenPathWritable,
  toStoredToken,
  writeTokenFile,
} from "../lib/token-file.ts";

const command = define({
  name: "token",
  description:
    "認可コードをアクセストークン・リフレッシュトークンに交換し、トークンファイルへ保存する (認可から数分以内に実行する。auth-url と組み合わせて使う退路)",
  args: {
    port: {
      type: "number",
      short: "p",
      default: DEFAULT_PORT,
      description:
        `redirect_uri (http://localhost:<port>) に使う port (既定 ${DEFAULT_PORT})。auth-url 実行時と同じ値を指定する`,
    },
  },
  run: async (ctx) => {
    const code = ctx.positionals[0];
    const { port } = ctx.values;
    if (code === undefined) {
      console.error("usage: token <code>");
      Deno.exit(1);
    }

    try {
      const config = loadTokenConfig(port);
      await assertTokenPathWritable(config.tokenPath);
      const resp = await exchangeCode({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.redirectUri,
        code,
      });
      const stored = toStoredToken(resp, new Date());
      await writeTokenFile(config.tokenPath, stored);
      console.log(
        JSON.stringify(
          {
            token_path: config.tokenPath,
            expires_in: stored.expires_in,
            refresh_token_expires_in: stored.refresh_token_expires_in,
            obtained_at: stored.obtained_at,
          },
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
