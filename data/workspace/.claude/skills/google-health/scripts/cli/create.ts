import { cli, define } from "gunshi";
import { loadTokenConfig } from "../lib/config.ts";
import { getValidToken } from "../lib/token-file.ts";
import { checkOperationDone, parseBodyArg, readBodyArg } from "../lib/body.ts";
import { API_BASE, request } from "../lib/api.ts";

const command = define({
  name: "create",
  description:
    "Google Health API の dataPoints (POST .../dataTypes/<type>/dataPoints) へ 1 件登録し、応答 (Operation) をそのまま標準出力へ出す",
  args: {
    body: {
      type: "string",
      description:
        "登録する DataPoint の JSON (文字列)。'-' を指定すると標準入力から読む",
    },
  },
  run: async (ctx) => {
    const dataType = ctx.positionals[0];
    const { body } = ctx.values;
    if (dataType === undefined) {
      console.error(
        "usage: create <dataType> --body='<JSON>' (または --body=-)",
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
      const url = `${API_BASE}/users/me/dataTypes/${dataType}/dataPoints`;
      const text = await request(url, token.access_token, "POST", parsed);

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
