import { assertEquals } from "@std/assert";
import { fingerprint, parseDayTables, scoreIndexes } from "./parse.ts";

const MNT = (n: number | null) =>
  n === null
    ? `<td class="t_no"></td>`
    : `<td><img src="https://x/kanko/tozan/mnt${n}.gif" alt="登山指数" width="50px"></td>`;
const TEMP = (t: number | null) =>
  t === null ? `<td class="t_no"></td>` : `<td id="temp-d"><b>${t}℃</b></td>`;
const WIND = (dir: string | null, ms: number | null) =>
  dir === null
    ? `<td class="t_no"></td>`
    : `<td id="wind-d"><img src="https://x/windm/wind_${dir}.gif" alt="風向"><span class="kwin01">${ms}</span></td>`;

// 今日: 先頭 5 列が過去 (t_no)、末尾 3 列が予報。気圧面は 925/950 の 2 面。
const todayTable = `
<tr class="tit_day"><td colspan="10">今&nbsp;日&nbsp;&nbsp;7/3(金)</td></tr>
<tr class="t_b">
<td colspan="2">時　間</td>
<td>00</td><td>03</td><td>06</td><td>09</td><td>12</td><td>15</td><td>18</td><td>21</td>
</tr>
<tr class="t_w mnt_td">
<td colspan="2">登山指数</td>
${MNT(null)}${MNT(null)}${MNT(null)}${MNT(null)}${MNT(null)}${MNT(1)}${MNT(1)}${
  MNT(2)
}
</tr>
<tr class="t_w">
<td nowrap rowspan="2">高度760m付近<br>（925hPa）</td><td>気温</td>
${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(16)}${
  TEMP(15)
}${TEMP(14)}
</tr>
<tr class="t_w">
<td nowrap>風（m/s）</td>
${WIND(null, null)}${WIND(null, null)}${WIND(null, null)}${WIND(null, null)}${
  WIND(null, null)
}${WIND("ene", 1)}${WIND("se", 1)}${WIND("ssw", 2)}
</tr>
<tr class="t_w">
<td nowrap rowspan="2">高度500m付近<br>（950hPa）</td><td>気温</td>
${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(18)}${
  TEMP(17)
}${TEMP(15)}
</tr>
<tr class="t_w">
<td nowrap>風（m/s）</td>
${WIND(null, null)}${WIND(null, null)}${WIND(null, null)}${WIND(null, null)}${
  WIND(null, null)
}${WIND("ene", 2)}${WIND("ese", 1)}${WIND("s", 2)}
</tr>`;

// 麓の天気・気温・降水量テーブル (mnt_td なし・hPa なし)。同じ見出しだが正本にしない。
const todayTenkiTable = `
<tr class="tit_day"><td colspan="9">今&nbsp;日&nbsp;&nbsp;7/3(金)</td></tr>
<tr class="t_b">
<td>時　間</td>
<td>00</td><td>03</td><td>06</td><td>09</td><td>12</td><td>15</td><td>18</td><td>21</td>
</tr>
<tr class="t_w">
<td>天　気</td>
${TEMP(null)}${TEMP(null)}${TEMP(null)}${TEMP(null)}${
  TEMP(null)
}<td><img src="https://x/tenkim/s11.gif" alt="天気"></td><td><img src="https://x/tenkim/s11.gif" alt="天気"></td><td><img src="https://x/tenkim/s11.gif" alt="天気"></td>
</tr>`;

Deno.test("時間帯別: 過去列は null、末尾 3 列に指数が入る", () => {
  const t = parseDayTables(todayTable).find((x) => x.heading === "今日7/3(金)");
  assertEquals(t?.kind, "timeband");
  assertEquals(t?.index, [null, null, null, null, null, "A", "A", "B"]);
});

Deno.test("時間帯別: 気圧面 2 面の気温・風を列位置で対応づける", () => {
  const t = parseDayTables(todayTable).find((x) => x.heading === "今日7/3(金)");
  assertEquals(t?.levels.length, 2);
  assertEquals(t?.levels[0], {
    alt: "高度760m付近",
    hPa: 925,
    temp: [null, null, null, null, null, 16, 15, 14],
    wind: [
      { dir: null, ms: null },
      { dir: null, ms: null },
      { dir: null, ms: null },
      { dir: null, ms: null },
      { dir: null, ms: null },
      { dir: "ENE", ms: 1 },
      { dir: "SE", ms: 1 },
      { dir: "SSW", ms: 2 },
    ],
  });
  assertEquals(t?.levels[1].hPa, 950);
  assertEquals(t?.levels[1].temp, [null, null, null, null, null, 18, 17, 15]);
});

Deno.test("麓の天気テーブル (mnt_td/hPa なし) は同見出しでも正本にしない", () => {
  // 天気テーブルを先に置いても、気圧面ありの登山指数テーブルが正本になる。
  const tables = parseDayTables(todayTenkiTable + todayTable);
  const t = tables.find((x) => x.heading === "今日7/3(金)");
  assertEquals(t?.index, [null, null, null, null, null, "A", "A", "B"]);
  assertEquals(t?.levels.length, 2);
});

// 週間 only-pc (6 日) と only-sm 分割版 (3 日)。列数最大の only-pc を正本にする。
const weekPc = `
<tr class="tit_day"><td colspan="8">週　間　予　報</td></tr>
<tr class="t_b">
<td colspan="2">日　付</td>
<td>&nbsp;7/5(日)</td><td>&nbsp;7/6(月)</td><td>&nbsp;7/7(火)</td><td>&nbsp;7/8(水)</td><td>&nbsp;7/9(木)</td><td>&nbsp;7/10(金)</td>
</tr>
<tr class="t_w mnt_td">
<td colspan="2">登山指数</td>${MNT(1)}${MNT(2)}${MNT(2)}${MNT(1)}${MNT(3)}${
  MNT(3)
}
</tr>
<tr class="t_w">
<td nowrap rowspan="2">高度760m付近<br>（925hPa）</td><td>気温</td>
${TEMP(15)}${TEMP(15)}${TEMP(16)}${TEMP(17)}${TEMP(15)}${TEMP(15)}
</tr>
<tr class="t_w">
<td nowrap>風（m/s）</td>
${WIND("ssw", 5)}${WIND("s", 10)}${WIND("sse", 5)}${WIND("s", 5)}${
  WIND("s", 8)
}${WIND("sse", 5)}
</tr>`;
const weekSm = `
<tr class="tit_day"><td colspan="5">週　間　予　報</td></tr>
<tr class="t_b">
<td colspan="2">日　付</td>
<td>&nbsp;7/5(日)</td><td>&nbsp;7/6(月)</td><td>&nbsp;7/7(火)</td>
</tr>
<tr class="t_w mnt_td">
<td colspan="2">登山指数</td>${MNT(3)}${MNT(3)}${MNT(3)}
</tr>`;

Deno.test("週間: only-sm 分割版ではなく列数最大の only-pc 6 日を正本にする", () => {
  const t = parseDayTables(weekSm + weekPc).find((x) =>
    x.heading === "週間予報"
  );
  assertEquals(t?.kind, "weekly");
  assertEquals(t?.columns.length, 6);
  assertEquals(t?.index, ["A", "B", "B", "A", "C", "C"]);
  assertEquals(t?.levels[0].temp, [15, 15, 16, 17, 15, 15]);
});

Deno.test("週間: 指数 gif が日付列より少なければ左詰めし末尾を null にする", () => {
  const shortWeek = `
<tr class="tit_day"><td colspan="8">週　間　予　報</td></tr>
<tr class="t_b">
<td colspan="2">日　付</td>
<td>&nbsp;7/5(日)</td><td>&nbsp;7/6(月)</td><td>&nbsp;7/7(火)</td><td>&nbsp;7/8(水)</td>
</tr>
<tr class="t_w mnt_td">
<td colspan="2">登山指数</td>${MNT(1)}${MNT(2)}${MNT(3)}
</tr>`;
  const t = parseDayTables(shortWeek).find((x) => x.heading === "週間予報");
  assertEquals(t?.index, ["A", "B", "C", null]);
});

Deno.test("見出しが無ければ空配列", () => {
  assertEquals(parseDayTables("<html>no tables</html>"), []);
});

Deno.test("fingerprint は日付・指数 gif・気圧面を出現順に連結する", () => {
  const fp = fingerprint(todayTable);
  assertEquals(fp, "7/3(金)|mnt1.gif|mnt1.gif|mnt2.gif|925hPa|950hPa");
});

Deno.test("scoreIndexes は C を重く合算する (慎重側の比較用)", () => {
  const tables = parseDayTables(weekPc);
  // A,B,B,A,C,C = 0+1+1+0+2+2 = 6
  assertEquals(scoreIndexes(tables), 6);
});

Deno.test("実データ (青山) スナップショット: 指数と気圧面が崩れない", async () => {
  const html = await Deno.readTextFile(
    new URL("../testdata/aoyama-kad.utf8.html", import.meta.url),
  );
  const tables = parseDayTables(html);
  const today = tables.find((t) => t.heading === "今日7/3(金)");
  const week = tables.find((t) => t.heading === "週間予報");

  assertEquals(today?.index, [null, null, null, null, null, "A", "A", "A"]);
  assertEquals(today?.levels.map((l) => l.hPa), [925, 950]);
  assertEquals(today?.levels[0].temp, [
    null,
    null,
    null,
    null,
    null,
    16,
    15,
    14,
  ]);

  assertEquals(week?.columns.length, 6);
  assertEquals(week?.index, ["A", "B", "B", "A", "C", "C"]);
  assertEquals(week?.levels[0].temp, [15, 15, 16, 17, 15, 15]);
});
