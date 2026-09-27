import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import { checkOperationDone, parseBodyArg, readBodyArg } from "../lib/body.ts";
import { API_BASE, request } from "../lib/api.ts";

const command = define({
  name: "update",
  description:
    "Google Health API の dataPoint 1 件を PATCH <name> で更新し、応答をそのまま標準出力へ出す",
  args: {
    body: {
      type: "string",
      description:
        "更新後の DataPoint の JSON (文字列)。'-' を指定すると標準入力から読む",
    },
    "update-mask": {
      type: "string",
      description:
        "更新するフィールドをカンマ区切りで指定する (query の updateMask に載せる。省略可)。2026-09-27 の実測では 400 で拒否された (Cannot bind query parameter)。通常は付けない",
    },
  },
  run: async (ctx) => {
    const name = ctx.positionals[0];
    const { body, "update-mask": updateMask } = ctx.values;
    if (name === undefined) {
      console.error(
        "usage: update <dataPoint name> --body='<JSON>' (または --body=-) [--update-mask=<field,...>]",
      );
      Deno.exit(1);
    }
    if (body === undefined) {
      console.error("usage: --body は必須 ('-' で標準入力から読む)");
      Deno.exit(1);
    }

    try {
      const parsed = parseBodyArg(await readBodyArg(body));

      const config = loadTokenConfig();
      const token = await getValidToken(config);
      const url = new URL(`${API_BASE}/${name}`);
      if (updateMask !== undefined) {
        url.searchParams.set("updateMask", updateMask);
      }
      const text = await request(
        url.toString(),
        token.access_token,
        "PATCH",
        parsed,
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
