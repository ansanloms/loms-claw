# mountain-weather CLI ツール

てんくらの登山指数 HTML を解析する CLI ツール群。

## コマンド一覧

| コマンド       | 説明                                                   |
| -------------- | ------------------------------------------------------ |
| `weekly-index` | 週間部の「日付 -> 登山指数 (A/B/C)」を列位置で抽出する |

---

## weekly-index

てんくら `kad.html` (iconv で UTF-8 化済み) の週間部から、各日の登山指数を抽出して `日付 -> 指数` の形式で出力する。

日付行 (`tr.t_b`) と指数行 (`tr.t_w.mnt_td`) は別々の `<tr>` で列が 1:1 に並ぶ。テキスト上の行近接 (`grep -A` 等) では指数行の先頭列を別日と取り違えるため、列インデックスで対応づける。欠測列 (`<img>` なし) は `-` のまま出力する。only-sm の 3 日分割版ではなく、列数が最大の only-pc 6 日 1 行を正本にする。

```sh
deno task weekly-index <utf8-html-path>
```

### 例

```sh
curl -sSL -A "Mozilla/5.0" \
  "https://tenkura.n-kishou.co.jp/tk/kanko/kad.html?code=01150271&type=15" \
  -o /tmp/tenkura-kad.html
iconv -f SHIFT_JIS -t UTF-8//IGNORE /tmp/tenkura-kad.html > /tmp/tenkura-kad.utf8.html

deno task --cwd .claude/skills/mountain-weather/scripts weekly-index /tmp/tenkura-kad.utf8.html
```

### 出力例

```
7/1(水) -> A
7/2(木) -> B
7/3(金) -> C
7/4(土) -> A
7/5(日) -> B
7/6(月) -> -
```

---

## エラー時の挙動

ファイルパス未指定、または週間部の登山指数が抽出できなかった場合は stderr にメッセージを出力し、exit code 1 で終了する。抽出 0 件は HTML 構造変化の可能性があるため、値を捏造せず停止する。
