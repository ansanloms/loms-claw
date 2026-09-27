import { cli, define } from "gunshi";
import { loadTokenPathConfig } from "../lib/config.ts";
import { computeTokenStatus, readTokenFile } from "../lib/token-file.ts";

const command = define({
  name: "token-status",
  description:
    "トークンファイルの access_token 残り秒・refresh_token 残り日数を出す (refresh_token 失効時は再認可を促して非 0 終了)",
  args: {},
  run: async () => {
    try {
      const config = loadTokenPathConfig();
      const token = await readTokenFile(config.tokenPath);
      const status = computeTokenStatus(token);

      if (status.refresh_token_expired) {
        console.error(
          "refresh_token が失効している。deno task auth で再認可すること (localhost に届かない端末では auth-url と token <code> の組み合わせ)。",
        );
        Deno.exit(1);
      }

      console.log(JSON.stringify(status));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
