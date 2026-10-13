import { test } from "node:test";
import assert from "node:assert/strict";
import { parseKasel, prefectureOf, searchMountains } from "./kasel.ts";

const HTML = `
<tr id="tr_line"><td id="in_tb"><a href="kad.html?code=01150155&type=15&ba=hk">大雪山・赤岳</a></td>
<td id="in_tb"><a href="kad.html?code=01150010&type=15&ba=hk">大雪山・旭岳</a></td>
<td id="in_tb"><a href="kad.html?code=01150322&amp;type=15&amp;ba=hk">旭岳石室</a></td></tr>
`;

test("parseKasel: & と &amp; の両形式のアンカーを抽出する", () => {
  const entries = parseKasel(HTML, "hk");
  assert.deepEqual(entries.length, 3);
  assert.deepEqual(entries[1], {
    code: "01150010",
    name: "大雪山・旭岳",
    ba: "hk",
  });
  assert.deepEqual(entries[2].name, "旭岳石室");
});

test("parseKasel: ba の echo が要求と不一致なら例外 (CDN 別地域)", () => {
  assert.throws(() => parseKasel(HTML, "th"), /別地域/);
});

test("parseKasel: エントリ 0 件は例外 (構造変化)", () => {
  assert.throws(() => parseKasel("<html></html>", "hk"), /抽出できなかった/);
});

test("searchMountains: 部分一致で検索し code で重複排除する", () => {
  const entries = [
    ...parseKasel(HTML, "hk"),
    { code: "01150010", name: "大雪山・旭岳", ba: "hk" }, // 重複
  ];
  const hits = searchMountains(entries, "旭岳");
  assert.deepEqual(
    hits.map((h) => h.code),
    ["01150010", "01150322"],
  );
});

test("prefectureOf: code 先頭 2 桁から都道府県名を引く", () => {
  assert.deepEqual(prefectureOf("01150010"), "北海道");
  assert.deepEqual(prefectureOf("19150004"), "山梨県");
  assert.deepEqual(prefectureOf("99150000"), "");
});
