const INDEX_LABEL: Record<string, string> = { "1": "A", "2": "B", "3": "C" };

export type WeeklyIndex = { date: string; index: string };

/** 指数なし (欠測・予報範囲外) を表すトークン。 */
const NO_INDEX = "-";

/**
 * てんくら kad.html (iconv で UTF-8 化済み) の週間部から「日付 -> 登山指数」を抽出する。
 *
 * 日付行 (tr.t_b) と指数行 (tr.t_w.mnt_td) は別々の <tr> で、列が左から並ぶ。
 * テキスト上の行近接 (grep -A 等) では指数行の先頭列を別日と取り違えるため、
 * 列インデックスで対応づける。
 *
 * 指数 gif の数が日付列数より少ないことがある (最も先の日付が予報範囲外で gif 欠落、
 * 行末に "-" セルが付くか列自体が欠ける)。指数は最も近い日付 (左) から順に対応づけ
 * (左詰め)、足りない分は最も先の日付を NO_INDEX とする。末尾を残す (右詰め) と、
 * 近い日付の指数が 1 つずれて別日の値を読む。
 *
 * only-sm の 3 日分割版も同じ正規表現に当たるので、列数が最大の組
 * (only-pc の 6 日 1 行) を正本にする。
 */
export function parseWeeklyIndex(html: string): WeeklyIndex[] {
  let best: [string[], string[]] | null = null;
  const re =
    /<tr class="t_b">([\s\S]*?)<tr class="t_w mnt_td">([\s\S]*?)<\/tr>/g;

  for (const m of html.matchAll(re)) {
    const cells = (s: string) =>
      [...s.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);

    const dates = cells(m[1])
      .filter((d) => /\d+\/\d+/.test(d))
      .map((d) => d.replace(/\s|&nbsp;/g, ""));

    // 値セルだけを左から順に拾う。先頭のラベルセル (登山指数) は集合に入らず除外され、
    // 件数差は末尾ではなく不足分として現れる (= 左詰め)。
    const idx = cells(m[2])
      .map((c) => {
        const g = c.match(/mnt([123])\.gif/);
        if (g) {
          return INDEX_LABEL[g[1]];
        }
        const text = c.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();
        return text === "" ? NO_INDEX : text;
      })
      .filter((v) => v === "A" || v === "B" || v === "C" || v === NO_INDEX);

    if (dates.length > 0 && (best === null || dates.length > best[0].length)) {
      best = [dates, idx];
    }
  }

  if (best === null) {
    return [];
  }
  // 左詰め: 日付列数より値が少なければ、最も先の日付を NO_INDEX で埋める。
  return best[0].map((date, i) => ({ date, index: best![1][i] ?? NO_INDEX }));
}

if (import.meta.main) {
  const path = Deno.args[0];
  if (path === undefined) {
    console.error("usage: deno task weekly-index <utf8-html-path>");
    Deno.exit(1);
  }

  const rows = parseWeeklyIndex(await Deno.readTextFile(path));
  if (rows.length === 0) {
    console.error("週間部の登山指数を抽出できなかった (HTML 構造変化の可能性)");
    Deno.exit(1);
  }

  for (const r of rows) {
    console.log(`${r.date} -> ${r.index}`);
  }
}
