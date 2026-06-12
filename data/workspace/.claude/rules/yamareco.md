# ヤマレコ情報取得

ユーザの登山履歴・各山行のタイム・ペースを取得する手順。

## 情報

- ヤマレコ OpenAPI 仕様: <https://github.com/ansanloms/yamareco-openapi>

## 山行リスト取得

```bash
curl -s 'https://api.yamareco.com/api/v1/getReclist/user/{userId}/{page}' \
  --header 'Accept: application/json'
```

- pathname の `{userId}`は ヤマレコユーザID(数値)
- pathname の `{page}`はページ番号(1 始まり)
- レスポンスの `reclist[].rec_id` が個別山行の ID
- `reclist[].permission.guest` が `"1"` ならゲスト閲覧可、`"0"` なら非公開
- `reclist[].place` / `start` / `end` / `area` などで概要把握可能
- `reclist[].page_url` に詳細ページの HTML URL（後述）

## 個別山行の詳細取得

`GET /api/v1/getRec/{rec_id}` は OAuth 認証が必要で、未認証だと `{"err":1,"message":"App does not have a valid scope."}` が返る。

**現状は API では詳細取れない。HTML から抽出する。**

### HTML から抽出する手順

公開設定(`permission.guest=1`)の山行のみ取得可能。

```bash
# 1. HTML 取得（User-Agent 必須、403 を避ける）
curl -s -A "Mozilla/5.0" \
  "https://www.yamareco.com/modules/yamareco/detail-{rec_id}.html" \
  -o /tmp/y.html

# 2. EUC-JP → UTF-8 変換
iconv -f EUC-JP -t UTF-8 /tmp/y.html > /tmp/y_utf8.html
```

- WebFetch ツールはなぜか 403 を返すので curl 直叩きが確実
- 文字コードは EUC-JP。iconv での変換必須（しないと grep が日本語を拾えない）

### 抽出ポイント

UTF-8 変換後の HTML を Grep する。

| 項目 | パターン |
|---|---|
| 山行時間 | `class="time1">[0-9:]+` |
| 休憩時間 | `class="time2">[0-9:]+` |
| 合計時間 | `class="time3">[0-9:]+` |
| 距離・登り・下り | `font-weight:bold;font-size:18px;">[0-9.]+</span>(km\|m)` |
| ペース区分 | `pace[1-4]">(とても速い\|速い\|普通\|遅い)` |
| ペース倍率 | `pace-num.{1,150}` 内の `font-en">[0-9.]+` |

`time1` / `time2` / `time3` は HTML 内に複数マッチがあるので **最初の 1 件** を採用すること（コースタイム表示用と日付表示用が混在）。

### ペース倍率の読み方

ヤマレコの「らくルート」標準コースタイムを 1.0 としたときの倍率。

- 0.5〜0.6: とても速い
- 0.6〜0.7: 速い〜とても速い
- 0.7〜0.8: 速い
- 0.9〜1.0: 普通
- 1.1 以上: ゆっくり

ユーザの過去実績を集めて平均ペースを出せば、未経験ルートの所要時間を標準 CT × 平均倍率で予測できる。

## 登山計画への活用

1. 過去の山行タイムからペース倍率を集計
2. ヤマレコや登山地図アプリで標準 CT を確認
3. 平均倍率を掛けて予測タイムを算出
4. 休憩を 1〜1.5 時間上乗せして合計時間とする
5. 標高・距離・累積標高がユーザ実績の最大値を超える場合は楽観しすぎるな

## 注意

- 詳細を取りたい山行は事前にユーザにヤマレコの公開設定を依頼
- HTML 構造は変わる可能性あり。抽出失敗したらこのルール更新
