# mountain-weather CLI ツール

てんくらの登山指数 HTML を取得・解析する CLI ツール。

## fetch-index

山のコード (`kad.html?code=` の数値) を渡すと、てんくらの登山指数ページを取得し、今日・明日 (時間帯別) と週間の登山指数・気温・風を JSON で返す。次を一括で行う。

- Shift_JIS の HTML を取得して UTF-8 にデコードする (iconv 不要)。
- キャッシュ回避クエリを付けて 2 回取得し fingerprint (日付・指数 gif・気圧面) を突き合わせる。不一致なら 3 回目で再現した版を採り、再現しなければ悪い側 (指数スコア最大 = 慎重側) を採る。CDN が別の山・古い版を返す事故への対策。
- 取得物が要求した山か検証する (`alt="登山指数"` の存在・`code=` の一致)。外れれば値を捏造せず exit 1 で停止する。
- 時間帯別・週間の各テーブルを列位置で対応づけて抽出する。過去時間帯 (`t_no`)・予報範囲外は `null`。同一見出しの分割版・麓の天気テーブルは正本にしない。

引数解析は [gunshi](https://gunshi.dev/) を使う。`--help` で使い方、各オプションに短縮形がある。

```sh
deno task fetch-index --code=<山のコード> [--type=15]   # -c / -t
deno task fetch-index --file=<iconv 済み UTF-8 HTML>    # -f。オフライン (取得済み HTML を解析)
deno task fetch-index --help                            # 使い方
```

`--code` は地域リスト `kasel.html` から引く (SKILL.md 参照)。`--type` は既定 15 (登山)。`--code` と `--file` のどちらも無ければ usage を出して exit 1。

### 出力 (JSON)

```jsonc
{
  "code": "01150271",
  "title": "青山の天気 | ...",
  "note": "2 回取得が一致", // どの版を採用したか
  "fingerprint": "7/3(金)|mnt1.gif|...",
  "tables": [
    {
      "kind": "timeband", // 時刻列 = timeband / 日付列 = weekly
      "heading": "今日7/3(金)",
      "columns": ["00", "03", "06", "09", "12", "15", "18", "21"],
      "index": [null, null, null, null, null, "A", "A", "A"], // 過去時間帯は null
      "levels": [
        {
          "alt": "高度760m付近",
          "hPa": 925,
          "temp": [null, null, null, null, null, 16, 15, 14],
          "wind": [/* ... */ { "dir": "SSW", "ms": 2 }]
        }
        // 950hPa ...
      ]
    }
    // 明日 (timeband) / 週間予報 (weekly) ...
  ]
}
```

- `index` は各列の登山指数 A/B/C。`null` は過去時間帯 (`t_no`) または予報範囲外 (週間の最も先)。指数と時刻・日付は同じ列インデックスで対応する。
- `levels` は気圧面ごとの気温 (℃) と風 (`dir` 16 方位、`ms` m/s)。低山は 925/950hPa、高山は 600/700hPa など。山頂標高に近い気圧面を選ぶのは呼び出し側の判断 (SKILL.md 参照)。

パース本体は `cli/parse.ts` の `parseDayTables` に分離してある (ネットワーク非依存でテスト可能)。HTML 構造が変わって抽出に失敗したらここを更新する。

## エラー時の挙動

`--code`/`--file` 未指定、取得物の検証失敗 (`alt="登山指数"` 0 件・`code=` 不一致)、テーブル抽出 0 件のいずれも stderr にメッセージを出力し exit code 1 で終了する。抽出 0 件は HTML 構造変化の可能性があるため、値を捏造せず停止する。
