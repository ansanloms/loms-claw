import { assertEquals } from "@std/assert";
import { parseWeeklyIndex } from "./weekly-index.ts";

const MNT = (n: number) =>
  `<td><img src="https://example/kanko/tozan/mnt${n}.gif" alt="登山指数" width="50px"></td>`;

// today/tomorrow 部 (時間帯 8 列の登山指数行)。日付ではなく時刻なので抽出対象外。
const todayBlock = `
<tr class="tit_day"><td colspan="9">明　日　6/29(月)</td></tr>
<tr class="t_b">
<td>時　間</td><td>00</td><td>03</td><td>06</td><td>09</td><td>12</td><td>15</td><td>18</td><td>21</td>
</tr><tr class="t_w mnt_td">
<td>登山指数</td>${MNT(1)}${MNT(1)}${MNT(1)}${MNT(1)}${MNT(1)}${MNT(1)}${
  MNT(1)
}${MNT(1)}
</tr>`;

// 週間 only-pc (6 日 1 行)。各列を別値にして列対応の判別を可能にする。7/6 は欠測。
const weekPcBlock = `
<tr class="tit_day"><td colspan="8">週　間　予　報</td></tr>
<tr class="t_b">
<td colspan="2">日　付</td>
<td>&nbsp;7/1(水)</td><td>&nbsp;7/2(木)</td><td>&nbsp;7/3(金)</td>
<td>&nbsp;7/4(土)</td><td>&nbsp;7/5(日)</td><td>&nbsp;7/6(月)</td>
</tr><tr class="t_w mnt_td">
<td colspan="2">登山指数</td>${MNT(1)}${MNT(2)}${MNT(3)}${MNT(1)}${
  MNT(2)
}<td>-</td>
</tr>`;

// only-sm の 3 日分割版。同じ正規表現に当たるが列数で負け、正本にならない。
const weekSmBlock = `
<tr class="t_b">
<td colspan="2">日　付</td>
<td>&nbsp;7/1(水)</td><td>&nbsp;7/2(木)</td><td>&nbsp;7/3(金)</td>
</tr><tr class="t_w mnt_td">
<td colspan="2">登山指数</td>${MNT(3)}${MNT(3)}${MNT(3)}
</tr>`;

const fixture = todayBlock + weekPcBlock + weekSmBlock;

Deno.test("週間部を列位置で日付に対応づける (行近接で誤読しない)", () => {
  const rows = parseWeeklyIndex(fixture);
  assertEquals(rows, [
    { date: "7/1(水)", index: "A" },
    { date: "7/2(木)", index: "B" },
    { date: "7/3(金)", index: "C" },
    { date: "7/4(土)", index: "A" },
    { date: "7/5(日)", index: "B" },
    { date: "7/6(月)", index: "-" },
  ]);
});

Deno.test("7/3 は 3 列目 C であり先頭列 (7/1=A) と取り違えない", () => {
  const rows = parseWeeklyIndex(fixture);
  assertEquals(rows.find((r) => r.date.startsWith("7/3"))?.index, "C");
});

Deno.test("欠測列は - のまま返す", () => {
  const rows = parseWeeklyIndex(fixture);
  assertEquals(rows.find((r) => r.date.startsWith("7/6"))?.index, "-");
});

Deno.test("only-sm 分割版ではなく列数最大の only-pc 6 日を正本にする", () => {
  const rows = parseWeeklyIndex(fixture);
  assertEquals(rows.length, 6);
});

Deno.test("週間部が無ければ空配列", () => {
  assertEquals(parseWeeklyIndex("<html>no weekly</html>"), []);
});

// 最も先の日付が予報範囲外で指数 gif が日付列数より少なく、末尾セルも無いケース。
// 指数は最も近い日付 (左) から詰め、足りない分は最も先の日付を指数なしにする (左詰め)。
const weekShortBlock = `
<tr class="tit_day"><td colspan="8">週　間　予　報</td></tr>
<tr class="t_b">
<td colspan="2">日　付</td>
<td>&nbsp;7/1(水)</td><td>&nbsp;7/2(木)</td><td>&nbsp;7/3(金)</td>
<td>&nbsp;7/4(土)</td><td>&nbsp;7/5(日)</td><td>&nbsp;7/6(月)</td>
</tr><tr class="t_w mnt_td">
<td colspan="2">登山指数</td>${MNT(1)}${MNT(2)}${MNT(3)}
</tr>`;

Deno.test("gif が日付列数より少なければ左詰めし、最も先の日付を指数なしにする", () => {
  const rows = parseWeeklyIndex(weekShortBlock);
  assertEquals(rows, [
    { date: "7/1(水)", index: "A" },
    { date: "7/2(木)", index: "B" },
    { date: "7/3(金)", index: "C" },
    { date: "7/4(土)", index: "-" },
    { date: "7/5(日)", index: "-" },
    { date: "7/6(月)", index: "-" },
  ]);
});
