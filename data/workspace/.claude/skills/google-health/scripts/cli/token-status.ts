#!/usr/bin/env node
import { resolve } from "node:path";
import { cli, define } from "gunshi";
import { loadTokenPathConfig } from "../lib/config.ts";
import { computeTokenStatus, readTokenFile } from "../lib/token-file.ts";

const SCRIPTS_DIR = resolve(import.meta.dirname, "..");

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
          `refresh_token が失効している。\`npx --no --prefix "${SCRIPTS_DIR}" -- auth\` で再認可すること (localhost に届かない端末では auth-url と token <code> の組み合わせ)。`,
        );
        process.exit(1);
      }

      console.log(JSON.stringify(status));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  },
});

await cli(process.argv.slice(2), command);
