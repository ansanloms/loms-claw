import { cli, define } from "gunshi";
import {
  type DayTable,
  fingerprint,
  parseDayTables,
  scoreIndexes,
} from "./parse.ts";

const BASE = "https://tenkura.n-kishou.co.jp/tk/kanko/kad.html";
const UA = "Mozilla/5.0";

type Result = {
  code: string;
  title: string;
  /** どの版を採用したか (2 回一致 / 再現 / 悪い側採用)。 */
  note: string;
  fingerprint: string;
  tables: DayTable[];
};

/** Shift_JIS の kad.html を取得し UTF-8 文字列にデコードする。 */
async function fetchDecoded(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Cache-Control": "no-cache" },
  });
  if (!res.ok) {
    throw new Error(`取得失敗 (HTTP ${res.status}): ${url}`);
  }
  const buf = await res.arrayBuffer();
  return new TextDecoder("shift-jis").decode(buf);
}

/** キャッシュ回避のためクエリを付けた URL を作る。 */
function bustUrl(code: string, type: string): string {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return `${BASE}?code=${code}&type=${type}&_=${nonce}`;
}

/** 取得物が要求した山の登山指数ページか検証する。違えば捏造せず停止する。 */
function ensureStructure(html: string, code: string): void {
  if (!/alt="登山指数"/.test(html)) {
    throw new Error(
      "登山指数が見つからない。type=15 の付け忘れ、または HTML 構造の変化の可能性。値を捏造せず停止する。",
    );
  }
  if (!html.includes(`code=${code}`)) {
    throw new Error(
      `要求した code=${code} がページ内に見つからない。CDN キャッシュで別ページを掴んだ可能性。取り直す。`,
    );
  }
}

/** <title> を取り出す (照合・報告用)。 */
function extractTitle(html: string): string {
  return html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? "";
}

/**
 * cache-bust 付きで 2 回取得し fingerprint を突き合わせる。一致すればその版、
 * 不一致なら 3 回目で再現した版を採り、再現しなければ悪い側 (指数スコア最大) を採る。
 * CDN が同じ URL でも別の版 (別の山・古い版) を返すことへの対策。
 */
async function robustFetch(
  code: string,
  type: string,
): Promise<{ html: string; note: string }> {
  const a = await fetchDecoded(bustUrl(code, type));
  ensureStructure(a, code);
  const b = await fetchDecoded(bustUrl(code, type));
  ensureStructure(b, code);

  if (fingerprint(a) === fingerprint(b)) {
    return { html: a, note: "2 回取得が一致" };
  }

  const c = await fetchDecoded(bustUrl(code, type));
  ensureStructure(c, code);
  if (fingerprint(c) === fingerprint(a)) {
    return { html: a, note: "3 回目で 1 回目と再現一致" };
  }
  if (fingerprint(c) === fingerprint(b)) {
    return { html: b, note: "3 回目で 2 回目と再現一致" };
  }

  const worst = [a, b, c]
    .map((html) => ({ html, score: scoreIndexes(parseDayTables(html)) }))
    .sort((x, y) => y.score - x.score)[0];
  return {
    html: worst.html,
    note: "3 版とも不一致。悪い側 (指数スコア最大) を採用",
  };
}

const command = define({
  name: "fetch-index",
  description: "てんくらの登山指数を取得し、時間帯別・週間を JSON で出力する",
  args: {
    code: {
      type: "string",
      short: "c",
      description: "山のコード (kad.html?code= の数値)",
    },
    type: {
      type: "string",
      short: "t",
      default: "15",
      description: "カテゴリ (既定 15 = 登山)",
    },
    file: {
      type: "string",
      short: "f",
      description: "オフライン: iconv 済み UTF-8 HTML を解析する",
    },
  },
  run: async (ctx) => {
    const { code: argCode, type, file } = ctx.values;

    let html: string;
    let note: string;
    let code = argCode ?? "";

    if (file !== undefined) {
      // オフライン: iconv で UTF-8 化済みのローカル HTML を解析する (fingerprint 比較・検証用)。
      html = await Deno.readTextFile(file);
      note = "ローカルファイル";
      if (code === "") {
        code = html.match(/code=(\d+)/)?.[1] ?? "";
      }
    } else if (argCode !== undefined) {
      try {
        const r = await robustFetch(argCode, type);
        html = r.html;
        note = r.note;
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        Deno.exit(1);
      }
    } else {
      console.error(
        "usage: fetch-index --code=<山のコード> | --file=<UTF-8 HTML>",
      );
      Deno.exit(1);
    }

    const tables = parseDayTables(html);
    if (tables.length === 0) {
      console.error(
        "登山指数テーブルを抽出できなかった (HTML 構造変化の可能性)。値を捏造せず停止する。",
      );
      Deno.exit(1);
    }

    const result: Result = {
      code,
      title: extractTitle(html),
      note,
      fingerprint: fingerprint(html),
      tables,
    };
    console.log(JSON.stringify(result, null, 2));
  },
});

if (import.meta.main) {
  await cli(Deno.args, command);
}
