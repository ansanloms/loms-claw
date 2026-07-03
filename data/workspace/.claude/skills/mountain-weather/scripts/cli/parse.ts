const INDEX_LABEL: Record<string, string> = { "1": "A", "2": "B", "3": "C" };

/** 各気圧面 (hPa) の気温・風。列は DayTable.columns と 1:1 で対応する。 */
export type Level = {
  /** 高度表記 (例: "高度760m付近")。参照気圧面のおおよその標高。 */
  alt: string;
  /** 気圧面 (hPa)。 */
  hPa: number;
  /** 各列の気温 (℃)。過去時間帯・予報範囲外は null。 */
  temp: (number | null)[];
  /** 各列の風。過去時間帯・予報範囲外は dir/ms とも null。 */
  wind: { dir: string | null; ms: number | null }[];
};

/** tit_day 見出し 1 つ分 (今日・明日の時間帯別、または週間) のテーブル。 */
export type DayTable = {
  /** columns が時刻 (00,03,...) なら timeband、日付 (7/5(日),...) なら weekly。 */
  kind: "timeband" | "weekly";
  /** tit_day 見出し (例: "今日7/3(金)" / "週間予報")。 */
  heading: string;
  /** 列ヘッダ。時刻 ["00",...] または日付 ["7/5(日)",...]。 */
  columns: string[];
  /** 各列の登山指数 A/B/C。過去時間帯・予報範囲外 (指数なし) は null。 */
  index: (string | null)[];
  /** 気圧面ごとの気温・風。低山は 925/950hPa、高山は 600/700hPa など。 */
  levels: Level[];
};

/** <td>...</td> の中身を左から順に返す (td はネストしない前提)。 */
function tds(rowInner: string): string[] {
  return [...rowInner.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
}

/** タグ・&nbsp;・空白を除いたセルのテキスト。 */
function cellText(cell: string): string {
  return cell.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "").replace(/\s/g, "");
}

/**
 * ラベルセル (登山指数・気温・風・hPa 表記・時間/日付見出しなど) を判定する。
 * データセル (気温の数値・風の gif・空の過去セル) はここに該当しない。
 */
function isLabelCell(cell: string): boolean {
  const t = cellText(cell);
  return /登山指数|日付|時間|気温|風|hPa|高度|天気|降水量/.test(t);
}

/**
 * 行の値をラベルセルを除いて左から拾い、列数 n に左詰めで揃える。
 *
 * 先頭ラベルセル数は行ごとに違う (指数 1・気温 2・風 1)。ラベルを除いた
 * データセルを列に 1:1 対応させ、足りない分 (週間の予報範囲外など) は
 * 末尾を欠損値で埋める (左詰め)。末尾を残す (右詰め) と近い列の値が
 * 1 つずれて別の日時の値を読む。
 */
function alignRow<T>(
  rowInner: string,
  n: number,
  map: (cell: string) => T,
  missing: T,
): T[] {
  const vals = tds(rowInner).filter((c) => !isLabelCell(c)).map(map);
  return Array.from(
    { length: n },
    (_, i) => (i < vals.length ? vals[i] : missing),
  );
}

/** 指数セル 1 つを A/B/C または null (過去・予報範囲外) に変換する。 */
function mapIndex(cell: string): string | null {
  const g = cell.match(/mnt([123])\.gif/);
  return g ? INDEX_LABEL[g[1]] : null;
}

/** 気温セル 1 つを数値 (℃) または null に変換する。 */
function mapTemp(cell: string): number | null {
  const m = cell.match(/(-?\d+)\s*℃/);
  return m ? Number(m[1]) : null;
}

/** 風セル 1 つを {dir, ms} に変換する。 */
function mapWind(cell: string): { dir: string | null; ms: number | null } {
  const d = cell.match(/wind_([a-z]+)\.gif/);
  const s = cell.match(/<span[^>]*>(\d+)<\/span>/);
  return {
    dir: d ? d[1].toUpperCase() : null,
    ms: s ? Number(s[1]) : null,
  };
}

/** t_b 行から列ヘッダ (時刻 or 日付) を拾う。 */
function headerColumns(segment: string): string[] {
  const tb = segment.match(/<tr class="t_b">([\s\S]*?)<\/tr>/);
  if (!tb) {
    return [];
  }
  return tds(tb[1])
    .map((c) => c.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim())
    .filter((t) => /^\d{2}$/.test(t) || /\d+\/\d+/.test(t));
}

/**
 * てんくら kad.html (iconv で UTF-8 化済み) から、今日・明日の時間帯別および
 * 週間の各テーブルを抽出する。
 *
 * 各テーブルは tit_day 見出し → t_b (列ヘッダ) → mnt_td (指数) → 気圧面ごとの
 * 気温行・風行、という共通構造を持つ。列はすべて同じ列インデックスで対応する
 * ため、テキスト上の行近接ではなく列位置で突き合わせる。
 *
 * 同じ見出しが複数の描画で重複する (only-pc の全列版・only-sm の分割版・
 * 麓の天気/降水量テーブル)。見出しごとに (列数, 気圧面数, 指数の有無) が最大の
 * ものを正本とし、分割版・気圧面なしの天気テーブルは捨てる。
 */
export function parseDayTables(html: string): DayTable[] {
  const segments = html
    .split(/(?=<tr class="tit_day">)/)
    .filter((s) => s.startsWith('<tr class="tit_day">'));

  const byHeading = new Map<string, DayTable>();

  for (const seg of segments) {
    const headMatch = seg.match(
      /<tr class="tit_day">\s*<td[^>]*>([\s\S]*?)<\/td>/,
    );
    if (!headMatch) {
      continue;
    }
    const heading = cellText(headMatch[1]);

    const columns = headerColumns(seg);
    const n = columns.length;
    if (n === 0) {
      continue;
    }
    const kind: DayTable["kind"] = /^\d{2}$/.test(columns[0])
      ? "timeband"
      : "weekly";

    const mnt = seg.match(/<tr class="t_w mnt_td">([\s\S]*?)<\/tr>/);
    const index = mnt
      ? alignRow(mnt[1], n, mapIndex, null)
      : Array<string | null>(n).fill(null);

    const levels: Level[] = [];
    for (const row of seg.matchAll(/<tr class="t_w">([\s\S]*?)<\/tr>/g)) {
      const inner = row[1];
      // 高度表記は "高度760m付近<br>（925hPa）" のようにタグを挟む。タグ跨ぎで拾う。
      const hpa = inner.match(/高度([\s\S]*?)（(\d+)hPa）/);
      if (hpa) {
        levels.push({
          alt: `高度${
            hpa[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, "").trim()
          }`,
          hPa: Number(hpa[2]),
          temp: alignRow(inner, n, mapTemp, null),
          // 風は直後の風行で埋める。見つからなければ null のまま。
          wind: Array.from({ length: n }, () => ({ dir: null, ms: null })),
        });
      } else if (/風（m\/s|wind_[a-z]+\.gif/.test(inner) && levels.length > 0) {
        levels[levels.length - 1].wind = alignRow(inner, n, mapWind, {
          dir: null,
          ms: null,
        });
      }
    }

    const table: DayTable = { kind, heading, columns, index, levels };
    const prev = byHeading.get(heading);
    if (prev === undefined || rank(table) > rank(prev)) {
      byHeading.set(heading, table);
    }
  }

  return [...byHeading.values()];
}

/** 見出し重複時の正本選択スコア。列数 > 気圧面数 > 指数ありセル数 の順で優先。 */
function rank(t: DayTable): number {
  const idx = t.index.filter((v) => v !== null).length;
  return t.columns.length * 10000 + t.levels.length * 100 + idx;
}

/**
 * キャッシュ突き合わせ用の fingerprint。日付/曜日・指数 gif・気圧面表記を
 * 出現順に連結する。CDN が別の版を返したかを主要値の一致で判定する。
 */
export function fingerprint(html: string): string {
  return [
    ...html.matchAll(/\d+\/\d+\([月火水木金土日]\)|mnt[123]\.gif|\d+hPa/g),
  ]
    .map((m) => m[0])
    .join("|");
}

/** 指数を A=0/B=1/C=2 で合算する。値が大きいほど悪い (慎重側)。 */
export function scoreIndexes(tables: DayTable[]): number {
  const w: Record<string, number> = { A: 0, B: 1, C: 2 };
  let sum = 0;
  for (const t of tables) {
    for (const v of t.index) {
      if (v !== null) {
        sum += w[v];
      }
    }
  }
  return sum;
}
