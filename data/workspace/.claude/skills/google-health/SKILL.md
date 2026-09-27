---
name: google-health
description: >-
  Google Health API (REST v4) から Fitbit・Pixel Watch の歩数・運動・消費カロリー・心拍・睡眠・体重・体脂肪率を取得する手順。
  「歩数」「今日の運動」「消費カロリー」「心拍」「睡眠時間」「体重」「体脂肪率」「Fitbit」「Pixel Watch」「Google Health」などを聞かれた際に使う。
  初回は認可コードの取得とトークン交換が必要で、Testing 状態のリフレッシュトークンは同意から 7 日で失効するため定期的な再認可が要る。
  データの取得専用で、Fitbit Web API を直接叩く用途・Google Fit (廃止済み)・Health Connect (端末内 API でサーバから読めない) の代替ではない。データ源としての Fitbit 機器・Pixel Watch は対象。
---

# Google Health のデータ取得

Google Health API (REST v4) から、Fitbit・Pixel Watch が記録した歩数・Active Minutes・Active Zone Minutes・距離・運動セッション・総消費カロリー・心拍・睡眠・体重・体脂肪率の記録を取得する手順。

## scripts の絶対パスを確定する

この skill のコマンド (`auth` ・ `auth-url` ・ `token` ・ `token-status` ・ `datapoints` ・ `daily-rollup`、いずれも後述) は `google-health/scripts` を `--cwd` に指定して実行する。パスは変数に代入せず、最初に 1 度だけ次のコマンドで絶対パスを確定し、以降の各コマンド例ではその結果をそのままリテラルで書き下す。理由: エージェントのシェルはコール間で cwd・変数を失う。

```sh
for d in "$PWD/.claude/skills/google-health" "$HOME/.claude/skills/google-health" "$PWD/google-health"; do
  if [ -d "$d/scripts" ]; then
    echo "$d/scripts"
  fi
done
```

- この skill のリポジトリ本体 (`ansanloms/skills`) 内で作業している場合は `$PWD/google-health/scripts` がヒットする。
- 複数ヒットしたら先に見つかったものを使う。
- 0 件のときは実際のインストール先を確認してから進める (推測でパスを組み立てない)。
- 以降のコマンド例中の `<scripts の絶対パス>` は、ここで確定した絶対パスに読み替える。呼び出すたびにこのパスをリテラルで書き下し、変数には入れない。

## 前提と制約

- Google Fit REST API は廃止済み (新規登録は 2024-05-01 終了、サポートは 2026 年末まで、代替なし)。Health Connect は端末内 API でサーバから読めない。Google Health API がサーバから叩ける唯一の公式手段。出典: <https://developer.android.com/health-and-fitness/health-connect/migration/fit/faq>
- データ源は Fitbit・Pixel Watch と、Health Connect 経由の一部データ型。公式ドキュメントでは Health Connect のデータ型は 2026 Q4 に追加予定で未提供とされていた。出典: <https://developers.google.com/health/about>。ただし 2026-09-27 時点の実測では、少なくとも体重 (`weight`) と体脂肪率 (`body-fat`) は取得できた。Health Planet アプリが Health Connect に書き込んだデータで、`dataSource.platform` が `HEALTH_CONNECT` として返る。
- 全スコープが Restricted だが、OAuth 同意画面を Testing (External) のままにし自分をテストユーザに登録すれば審査なしで使える (100 ユーザ上限)。出典: <https://developers.google.com/health/setup>, <https://developers.google.com/health/app-verification>
- Testing 状態のリフレッシュトークンは同意から 7 日で失効する。出典: <https://developers.google.com/health/setup>, <https://support.google.com/cloud/answer/15549945>。Internal (Google Cloud Organization 必須) や審査は使わない前提で、週 1 回の再認可を運用で受け入れる。再認可の手順は「初回認可」節と同じ。
- レート制限: ユーザ単位 300 requests/minute。超過時は 429 (「エラー時の挙動」参照)。出典: <https://developers.google.com/health/rate-limits>
- 料金の記載は公式ページ上に見当たらない (`/health/pricing` は 404)。
- データの登録・削除、プロフィール・ペアリング済みデバイス情報の取得は対象外 (取得専用)。
- `auth` コマンドは認可の主手段で、認可コードを `http://localhost:8765` (既定 port) で受け取る。実行環境の localhost にブラウザから届くことが前提。WSL2 なら Windows 側のブラウザから WSL2 の `localhost` へ届くのでそのまま使える。SSH 先やコンテナ内など届かない環境では、`auth-url` ・ `token` の組み合わせ (退路) を使う。

## 設定

Cloud Console で `health.googleapis.com` を有効化し、OAuth クライアント (Web Server、Authorized redirect URIs に `http://localhost:8765`) を作成、同意画面を Testing (External) にして自分をテストユーザに追加、Data Access に googlehealth のスコープを登録する (具体的なスコープ名 3 つは「初回認可」節の既定スコープ、または「データ型とスコープ」表を参照)。これらは人手の作業で、詳細は出典の setup ページにある。

次の環境変数を用意する。`redirect_uri` は port (既定 8765) から `http://localhost:<port>` を組み立ててスクリプト側で使うため、環境変数にはしない。`--port` で port を変えた場合は、Cloud Console の Authorized redirect URIs も同じ port の `http://localhost:<port>` に変更しておく。

| 変数名                        | 必須                                                                         | 意味                                                                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_HEALTH_CLIENT_ID`     | 必須                                                                         | OAuth クライアントの client_id                                                                                                  |
| `GOOGLE_HEALTH_CLIENT_SECRET` | `auth` ・ `token` ・ `datapoints` ・ `daily-rollup` で必須                   | OAuth クライアントの client_secret (`auth-url` ・ `token-status` では不要)                                                      |
| `GOOGLE_HEALTH_TOKEN_PATH`    | `auth` ・ `token` ・ `token-status` ・ `datapoints` ・ `daily-rollup` で必須 | トークン (access_token・refresh_token 等) を保存する JSON ファイルの絶対パス。推奨値: `~/.local/state/google-health/token.json` |

`GOOGLE_HEALTH_TOKEN_PATH` の親ディレクトリは事前に作成しておく (`auth` ・ `token` は親ディレクトリを自動作成しない)。推奨パスの場合は次のとおり。

```sh
mkdir -p -m 700 ~/.local/state/google-health
```

## 初回認可

### auth (主)

`auth` は認可 URL の表示と、`http://localhost:8765` (既定 port) での認可コードの受信・交換・保存を 1 コマンドで行う。ブラウザが実行環境の localhost に届く場合 (WSL2 なら Windows 側のブラウザから届く) に使う。

```sh
GOOGLE_HEALTH_CLIENT_ID=<client_id> \
  GOOGLE_HEALTH_CLIENT_SECRET=<client_secret> \
  GOOGLE_HEALTH_TOKEN_PATH=<トークンファイルの絶対パス> \
  deno task -q --cwd "<scripts の絶対パス>" auth
```

1. 標準出力に認可 URL、標準エラーに「ブラウザで開いて認可すること」の案内を出す。URL をユーザに提示し、ブラウザで開いてログイン・認可してもらう。
2. 認可後 `http://localhost:8765/?code=...` へリダイレクトされ、`auth` がそれを受信して自動でトークン交換・保存まで行い、ブラウザには「認可完了。このタブは閉じてよい」の HTML を返して終了する (exit 0)。
3. 認可がエラーだった場合 (`?error=...`) は標準エラーにエラー内容を出し、ブラウザには 400 の HTML を返して終了する (exit 1)。5 分以内に応答が無ければタイムアウトとして exit 1 になる。
4. 既定スコープは `activity_and_fitness.readonly` ・ `health_metrics_and_measurements.readonly` ・ `sleep.readonly` の 3 種。絞る・広げる場合は `--scope` を繰り返し指定する (`-s <scope> -s <scope> ...`)。
5. `--port` (既定 8765) で待ち受け port を変えられる。`deno task` の `--allow-net` は port を指定しない形にしてあるため `--port <n>` は task 経由でそのまま通る。変えた場合は Cloud Console の Authorized redirect URIs (登録 URI) も同じ port の `http://localhost:<port>` に変更しておく。

成功するとトークンファイル (`GOOGLE_HEALTH_TOKEN_PATH`) に `access_token` ・ `expires_in` ・ `refresh_token` ・ `refresh_token_expires_in` ・ `scope` ・ `token_type` ・ `obtained_at` ・ `refresh_token_obtained_at` を書き込む。`obtained_at` ・ `refresh_token_obtained_at` はいずれも RFC3339 形式の UTC で、ファイルのパーミッションは 0o600。トークン自体は標準出力に出さない。

実際のトークンファイルの構造 (`access_token` ・ `refresh_token` の値は `<masked>` に置換、他は実物、2026-09-26 取得。`refresh_token` 自体は refresh 応答に含まれなかったため前回発行時のまま据え置かれている)。`refresh_token_obtained_at` はリフレッシュトークン取得済みファイルが無い状態 (旧形式ファイル) から `datapoints` 等で自動更新した際に、refresh 応答の `refresh_token_expires_in` と組で追加されたもの (`computeTokenStatus` は `refresh_token_obtained_at` が無ければ `obtained_at` を fallback に使って動く)。

```jsonc
{
  "access_token": "<masked>",
  "expires_in": 3599,
  "refresh_token": "<masked>",
  "refresh_token_expires_in": 601041,
  "scope": "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "token_type": "Bearer",
  "obtained_at": "2026-09-26T09:56:43.968Z",
  "refresh_token_obtained_at": "2026-09-26T09:56:43.968Z"
}
```

### auth-url + token (退路)

ブラウザが実行環境の localhost に届かない端末 (SSH 先・コンテナ内等) で認可した場合の退路。`auth-url` で組み立てた URL をブラウザで開くと `http://localhost:8765/?code=...` へのリダイレクトで接続失敗ページになるが、アドレスバーに残った URL から `code` パラメータの値を取り出し、`token` コマンドへ渡す。

1. `auth-url` で認可 URL を組み立てる (`GOOGLE_HEALTH_CLIENT_ID` のみ必要)。

   ```sh
   GOOGLE_HEALTH_CLIENT_ID=<client_id> \
     deno task -q --cwd "<scripts の絶対パス>" auth-url
   ```

2. 出力された URL をユーザに提示し、ブラウザで開いてログイン・認可してもらう。認可後 `http://localhost:8765/?code=...` へのリダイレクトで接続失敗ページになるので、アドレスバーの `code` パラメータの値をユーザから受け取る。
3. 認可コードを `token` コマンドへ渡す。

   ```sh
   GOOGLE_HEALTH_CLIENT_ID=<client_id> \
     GOOGLE_HEALTH_CLIENT_SECRET=<client_secret> \
     GOOGLE_HEALTH_TOKEN_PATH=<トークンファイルの絶対パス> \
     deno task -q --cwd "<scripts の絶対パス>" token <認可コード>
   ```

   成功するとトークンファイル (`GOOGLE_HEALTH_TOKEN_PATH`) に `access_token` ・ `expires_in` ・ `refresh_token` ・ `refresh_token_expires_in` ・ `scope` ・ `token_type` ・ `obtained_at` ・ `refresh_token_obtained_at` を書き込む (構造は「auth (主)」節のトークンファイルの実例を参照)。`obtained_at` ・ `refresh_token_obtained_at` はいずれも RFC3339 形式の UTC で、ファイルのパーミッションは 0o600。標準出力へは次を返し、トークン自体は出力しない。

   ```jsonc
   {
     "token_path": "...",
     "expires_in": 3600,
     "refresh_token_expires_in": 604800,
     "obtained_at": "2026-09-26T00:00:00.000Z"
   }
   ```

   `auth-url` で `--port` を変えた場合は `token` にも同じ `--port` を渡す。

### 再認可

7 日ごとの再認可が必要。`token-status` でリフレッシュトークンの残り日数を確認し、失効前 (目安 1〜2 日前) に上記の認可を繰り返す。手段は `auth` が主で、退路は `auth-url` + `token`。

```sh
GOOGLE_HEALTH_TOKEN_PATH=<トークンファイルの絶対パス> \
  deno task -q --cwd "<scripts の絶対パス>" token-status
```

実行結果 (実測、2026-09-26 JST 取得): `deno task -q token-status`。

```json
{
  "access_token_expires_in_sec": 72,
  "refresh_token_expires_in_days": 7,
  "refresh_token_expired": false
}
```

`refresh_token_expired` が `true` のとき (残り日数が 0 以下) は、標準エラーに再認可が必要な旨を出して exit code 1 で終了する。このとき JSON は出力しない。

## サブコマンド

`datapoints` ・ `daily-rollup` はアクセストークンの期限切れ (`obtained_at` + `expires_in` 秒 - 60 秒のマージンを過ぎた場合) を実行前に自動検出し、リフレッシュトークンで更新してからデータ取得する。更新後のトークンはトークンファイルへ書き戻す。

### datapoints

```sh
GOOGLE_HEALTH_CLIENT_ID=<client_id> \
  GOOGLE_HEALTH_CLIENT_SECRET=<client_secret> \
  GOOGLE_HEALTH_TOKEN_PATH=<トークンファイルの絶対パス> \
  deno task -q --cwd "<scripts の絶対パス>" datapoints steps --from=2026-04-20 --to=2026-04-21
```

| 引数          | 必須 | 意味                                                                                                                                                                                                                                                                      |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置引数      | 必須 | dataType: `steps` / `active-minutes` / `active-zone-minutes` / `distance` / `exercise` / `heart-rate` / `sleep` / `weight` / `body-fat`                                                                                                                                   |
| `--from`      | 必須 | 取得範囲の開始。`YYYY-MM-DD` または RFC3339 (両方とも同じ形式で指定する)                                                                                                                                                                                                  |
| `--to`        | 必須 | 取得範囲の終了。`YYYY-MM-DD` または RFC3339。exclusive (filter は `>= from AND < to`)。日付なら `--to` の当日は含まれない。2026-09-26 を含めたければ `--to 2026-09-27` と指定する (`daily-rollup` の `--to` は inclusive で、内部で翌日 00:00:00 を end にする点と対照的) |
| `--reconcile` | 任意 | 指定すると `dataPoints:reconcile` (dataSourceFamily=google-wearables) で複数ソースをマージして取得する。google-wearables (Fitbit・Pixel Watch) 由来のデータだけをマージするため、Health Connect 由来の型 (`weight` ・ `body-fat`) では空になる (2026-09-27 実測)          |

- `heart-rate` ・ `weight` ・ `body-fat` (いずれも Sample 型) は RFC3339 のみ受け付ける。日付形式 (`YYYY-MM-DD`) を渡すとエラーになる。
- `exercise` は日付 (`YYYY-MM-DD`) のみ受け付ける。RFC3339 を渡すとエラーになる。理由: 実 API が `exercise.interval.start_time` を filter member として認めない。
- `sleep` は `--from`/`--to` が起床時刻 (interval の終端) で切られる。理由: 実 API は開始基準の filter member (`civil_start_time`・`start_time`) を認めない。終了基準の `civil_end_time`・`end_time` だけが通る。
- sleep は期間内の全セッション (昼寝を含む) を返す。夜の主睡眠は各レコードの `metadata.mainSleep: true` で見分ける (実測サンプルの `metadata.mainSleep` フィールドを参照)。
- `dataPoints:reconcile` も `dataPoints` (list) と同じ `pageSize` を受ける (2026-09-26 実測: sleep に `pageSize=25`、steps・heart-rate に `pageSize=10000` を付けて HTTP 200、件数も list と整合)。
- `weight` ・ `body-fat` は `--reconcile` を付けると `dataSourceFamily=users/me/dataSourceFamilies/google-wearables` に一致するデータが無く、空の `{"dataPoints":[]}` になる。2026-09-27 の実測では `health-connect` という family も無く、指定すると 400 (`Data family is missing or is not supported`) になる。この 2 型には `--reconcile` を付けない。
- 「直近の睡眠」は `sleep.interval.endTime` が最新のレコード、「昨夜の睡眠」は `mainSleep: true` かつ `endTime` に `endUtcOffset` (JST なら `32400s`) を足して得た暦日が当日のレコード、というように目的に応じてどちらの基準で選ぶかを明示する (sleep の `interval` には `civilStartTime`/`civilEndTime` が無い。実測サンプル参照)。
- `--from` と `--to` は同じ形式 (どちらも `YYYY-MM-DD`、またはどちらも RFC3339) でなければエラーになる。
- filter の組み立ては `lib/filter.ts` の表に集約してある (2026-09-26、Pixel Watch 4 で実測)。
  - steps・active-minutes・distance は `<snake>.interval.start_time` (RFC3339) と `<snake>.interval.civil_start_time` (日付) の両方が通る。active-zone-minutes は未実測で同じ表に乗せてあるだけ。
  - exercise は `exercise.interval.civil_start_time` (日付) のみ通る。
  - sleep は `sleep.interval.end_time` (RFC3339) と `sleep.interval.civil_end_time` (日付) のみ通る。
  - heart-rate・weight・body-fat (Sample 型) は、それぞれ `heart_rate.sample_time.physical_time`・`weight.sample_time.physical_time`・`body_fat.sample_time.physical_time` を使う。いずれも RFC3339 のみ受け付ける。
  - 非対応の組み合わせ (exercise + RFC3339、heart-rate + 日付など) はリクエスト前にエラーになり、メッセージにどちらの形式なら通るかを書く。
- 出力は `nextPageToken` が空になるまで全ページ結合した `{"dataPoints": [...]}`。最終ページは `dataPoints`・`nextPageToken` の両キーが省略された `{}` で返ることがある (2026-09-26 実測、steps 6 ページ目。proto3 の JSON マッピングで空の repeated field がまるごと省略されるため)。この場合はページ終端として扱い、それまでに集めた結果をそのまま返す。

### daily-rollup

```sh
GOOGLE_HEALTH_CLIENT_ID=<client_id> \
  GOOGLE_HEALTH_CLIENT_SECRET=<client_secret> \
  GOOGLE_HEALTH_TOKEN_PATH=<トークンファイルの絶対パス> \
  deno task -q --cwd "<scripts の絶対パス>" daily-rollup total-calories --from=2026-04-01 --to=2026-04-14
```

| 引数     | 必須 | 意味                                                                                                                                                                  |
| -------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置引数 | 必須 | dataType。identifier (kebab-case、例 `total-calories`) をそのまま URL パスに使う (2026-09-26 実測)。14 日上限の判定は下表の identifier 表記と完全一致した場合のみ働く |
| `--from` | 必須 | 取得範囲の開始。`YYYY-MM-DD`                                                                                                                                          |
| `--to`   | 必須 | 取得範囲の終了。`YYYY-MM-DD` (inclusive として扱い、内部で翌日 00:00:00 を end にする)                                                                                |

- `total-calories` ・ `heart-rate` ・ `active-minutes` ・ `calories-in-heart-rate-zone` は期間 (`--to` の翌日 - `--from`) が 14 日を超えるとリクエスト前にエラーになる。
  - `calories-in-heart-rate-zone` は公式リファレンスの上限リストに載る型。本 skill では未実測で、scope と filter メンバーは確認していない。
- `POST .../dataTypes/<dataType>/dataPoints:dailyRollUp` を `windowSizeDays: 1` で叩き、`nextPageToken` が空になるまで全ページ結合した `{"rollupDataPoints": [...]}` を出す。datapoints と同様、最終ページは両キー省略の `{}` で返ることがある (proto3 の空 repeated field 省略)。

## データ型とスコープ

出典: issue #77 (`gh issue view 77`)。

| データ              | identifier            | scope (`https://www.googleapis.com/auth/googlehealth` 配下) | 種別                      | filter で通るメンバー (実測、2026-09-26)                                                           |
| ------------------- | --------------------- | ----------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| 歩数                | `steps`               | `.activity_and_fitness.readonly`                            | Interval (1 分)           | `interval.civil_start_time` (日付) / `interval.start_time` (RFC3339)                               |
| Active Minutes      | `active-minutes`      | 同上                                                        | Interval (1 分)           | 同上                                                                                               |
| Active Zone Minutes | `active-zone-minutes` | 同上                                                        | Interval                  | 未実測 (上と同じ扱いにしてある)                                                                    |
| 距離                | `distance`            | 同上                                                        | Interval (1 分)           | 同上 (steps と同じ)                                                                                |
| 運動セッション      | `exercise`            | 同上                                                        | Session                   | `interval.civil_start_time` (日付) のみ。RFC3339 は 400                                            |
| 総消費カロリー      | `total-calories`      | 同上                                                        | rollUp / dailyRollUp のみ | 対象外 (dailyRollUp は filter を使わない)                                                          |
| 心拍                | `heart-rate`          | `.health_metrics_and_measurements.readonly`                 | Sample (1 秒)             | `sample_time.physical_time` (RFC3339 のみ)                                                         |
| 睡眠                | `sleep`               | `.sleep.readonly`                                           | Session                   | `interval.civil_end_time` (日付) / `interval.end_time` (RFC3339)。どちらも終了 (起床) 基準         |
| 体重                | `weight`              | `.health_metrics_and_measurements.readonly`                 | Sample                    | `sample_time.physical_time` (RFC3339 のみ)。`--reconcile` は空になるため付けない (2026-09-27 実測) |
| 体脂肪率            | `body-fat`            | `.health_metrics_and_measurements.readonly`                 | Sample                    | `sample_time.physical_time` (RFC3339 のみ)。`--reconcile` は空になるため付けない (2026-09-27 実測) |

`pageSize` の既定は 1440・最大 10000。`exercise` と `sleep` は既定・最大とも 25。スクリプトはデータ型ごとに上限値を `pageSize` として付ける (interval・sample 型は 10000、`exercise`・`sleep` は 25)。ただし `heart-rate` は `pageSize` 未指定で 50 件/ページだった (2026-09-26 実測)。既定値は型によって公式リファレンスの記載と異なりうるため、スクリプトでは常に上限値を明示指定している。

## レスポンスの形

### datapoints sleep --reconcile (公式ドキュメント掲載の例)

出典: <https://developers.google.com/health/endpoints> (2026-09-26 取得。stages 配列等は省略)。

```json
{
  "dataPoints": [
    {
      "name": "users/2515055256096816351/dataTypes/sleep/dataPoints/2724123844716220216",
      "dataSource": {
        "recordingMethod": "DERIVED",
        "device": { "displayName": "Charge 6" },
        "platform": "FITBIT"
      },
      "sleep": {
        "interval": {
          "startTime": "2026-03-03T20:57:30Z",
          "startUtcOffset": "0s",
          "endTime": "2026-03-04T04:41:30Z",
          "endUtcOffset": "0s"
        },
        "type": "STAGES",
        "summary": {
          "minutesAsleep": "407",
          "minutesAwake": "57",
          "stagesSummary": [{ "type": "DEEP", "minutes": "114", "count": "10" }]
        }
      }
    }
  ],
  "nextPageToken": ""
}
```

### datapoints sleep --reconcile (実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q datapoints sleep --from 2026-09-23 --to 2026-09-27 --reconcile` (Pixel Watch 4)。6 件中 1 件目。`stages` は全 13 件中先頭 2 件、`shortAwakenings` は全 11 件中先頭 1 件に絞った。`--reconcile` は複数ソースをマージするため、`summary.stagesSummary` に同じ内訳が重複して現れることがある (実測でもそうなっている)。

```jsonc
{
  "dataPoints": [
    {
      "dataPointName": "users/1173016576421350648/dataTypes/sleep/dataPoints/8808518358174752984",
      "sleep": {
        "interval": {
          "startTime": "2026-09-26T04:09:00Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-26T08:23:00Z",
          "endUtcOffset": "32400s"
        },
        "type": "STAGES",
        "stages": [
          {
            "startTime": "2026-09-26T04:09:00Z",
            "startUtcOffset": "32400s",
            "endTime": "2026-09-26T04:15:00Z",
            "endUtcOffset": "32400s",
            "type": "AWAKE",
            "createTime": "2026-09-26T08:33:37.998943Z",
            "updateTime": "2026-09-26T08:33:37.998943Z"
          },
          {
            "startTime": "2026-09-26T04:15:00Z",
            "startUtcOffset": "32400s",
            "endTime": "2026-09-26T04:28:00Z",
            "endUtcOffset": "32400s",
            "type": "LIGHT",
            "createTime": "2026-09-26T08:33:37.998943Z",
            "updateTime": "2026-09-26T08:33:37.998943Z"
          }
          // 全 13 件中先頭 2 件に絞った。以下省略。
        ],
        "metadata": {
          "stagesStatus": "SUCCEEDED",
          "processed": true,
          "mainSleep": true
        },
        "summary": {
          "minutesInSleepPeriod": "254",
          "minutesAfterWakeUp": "0",
          "minutesToFallAsleep": "0",
          "minutesAsleep": "248",
          "minutesAwake": "6",
          "stagesSummary": [
            { "type": "AWAKE", "minutes": "6", "count": "1" },
            { "type": "LIGHT", "minutes": "146", "count": "6" },
            { "type": "DEEP", "minutes": "48", "count": "3" },
            { "type": "REM", "minutes": "54", "count": "3" },
            { "type": "AWAKE", "minutes": "6", "count": "1" },
            { "type": "LIGHT", "minutes": "146", "count": "6" },
            { "type": "DEEP", "minutes": "48", "count": "3" },
            { "type": "REM", "minutes": "54", "count": "3" }
            // 実測どおり内訳が重複して返ってきている (--reconcile のマージによるものと見られる)。
          ]
        },
        "createTime": "2026-09-26T08:33:36.038623Z",
        "updateTime": "2026-09-26T08:33:42.827423Z",
        "shortAwakenings": [
          {
            "startTime": "2026-09-26T04:16:00Z",
            "startUtcOffset": "32400s",
            "endTime": "2026-09-26T04:17:00Z",
            "endUtcOffset": "32400s",
            "type": "LIGHT"
          }
          // 全 11 件中先頭 1 件に絞った。以下省略。
        ]
      }
    }
    // 全 6 件中 1 件目のみ掲載。
  ],
  "nextPageToken": ""
}
```

### datapoints sleep (--reconcile 無し、実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q datapoints sleep --from 2026-09-23 --to 2026-09-27` (Pixel Watch 4)。6 件中 1 件目 (`--reconcile` 版と同じ睡眠記録)。`stages` は全 13 件中先頭 2 件、`shortAwakenings` は全 11 件中先頭 1 件に絞った。`--reconcile` 無しでは `summary.stagesSummary` の重複は無い。

```jsonc
{
  "dataPoints": [
    {
      "name": "users/1173016576421350648/dataTypes/sleep/dataPoints/8808518358174752984",
      "dataSource": {
        "recordingMethod": "DERIVED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "sleep": {
        "interval": {
          "startTime": "2026-09-26T04:09:00Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-26T08:23:00Z",
          "endUtcOffset": "32400s"
        },
        "type": "STAGES",
        "stages": [
          {
            "startTime": "2026-09-26T04:09:00Z",
            "startUtcOffset": "32400s",
            "endTime": "2026-09-26T04:15:00Z",
            "endUtcOffset": "32400s",
            "type": "AWAKE",
            "createTime": "2026-09-26T08:33:37.998943Z",
            "updateTime": "2026-09-26T08:33:37.998943Z"
          },
          {
            "startTime": "2026-09-26T04:15:00Z",
            "startUtcOffset": "32400s",
            "endTime": "2026-09-26T04:28:00Z",
            "endUtcOffset": "32400s",
            "type": "LIGHT",
            "createTime": "2026-09-26T08:33:37.998943Z",
            "updateTime": "2026-09-26T08:33:37.998943Z"
          }
          // 全 13 件中先頭 2 件に絞った。以下省略。
        ],
        "metadata": {
          "stagesStatus": "SUCCEEDED",
          "processed": true,
          "mainSleep": true
        },
        "summary": {
          "minutesInSleepPeriod": "254",
          "minutesAfterWakeUp": "0",
          "minutesToFallAsleep": "0",
          "minutesAsleep": "248",
          "minutesAwake": "6",
          "stagesSummary": [
            { "type": "AWAKE", "minutes": "6", "count": "1" },
            { "type": "LIGHT", "minutes": "146", "count": "6" },
            { "type": "DEEP", "minutes": "48", "count": "3" },
            { "type": "REM", "minutes": "54", "count": "3" }
          ]
        },
        "createTime": "2026-09-26T08:33:36.038623Z",
        "updateTime": "2026-09-26T08:33:42.827423Z",
        "shortAwakenings": [
          {
            "startTime": "2026-09-26T04:16:00Z",
            "startUtcOffset": "32400s",
            "endTime": "2026-09-26T04:17:00Z",
            "endUtcOffset": "32400s",
            "type": "LIGHT"
          }
          // 全 11 件中先頭 1 件に絞った。以下省略。
        ]
      }
    }
    // 全 6 件中 1 件目のみ掲載。
  ],
  "nextPageToken": ""
}
```

### datapoints steps・active-minutes・distance (実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q datapoints steps --from 2026-09-25 --to 2026-09-26` (326 件中先頭 2 件)、`deno task -q datapoints active-minutes --from 2026-09-25 --to 2026-09-26` (216 件中先頭 1 件)、`deno task -q datapoints distance --from 2026-09-25 --to 2026-09-26` (326 件中先頭 1 件)。いずれも Pixel Watch 4、CLI の実出力 (`{"dataPoints": [...]}` の形で `nextPageToken` は含まない)。`civilStartTime`/`civilEndTime` は filter に `civil_start_time` (日付形式) を使ったときも常に付いてくる。

```jsonc
// steps
{
  "dataPoints": [
    {
      "dataSource": {
        "recordingMethod": "PASSIVELY_MEASURED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "steps": {
        "interval": {
          "startTime": "2026-09-25T14:58:00Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-25T14:59:00Z",
          "endUtcOffset": "32400s",
          "civilStartTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 58 }
          },
          "civilEndTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 59 }
          }
        },
        "count": "2"
      }
    },
    {
      "dataSource": {
        "recordingMethod": "PASSIVELY_MEASURED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "steps": {
        "interval": {
          "startTime": "2026-09-25T14:57:00Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-25T14:58:00Z",
          "endUtcOffset": "32400s",
          "civilStartTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 57 }
          },
          "civilEndTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 58 }
          }
        },
        "count": "44"
      }
    }
    // 全 326 件中先頭 2 件に絞った。以下省略。
  ]
}
```

```jsonc
// active-minutes
{
  "dataPoints": [
    {
      "dataSource": {
        "recordingMethod": "DERIVED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "activeMinutes": {
        "interval": {
          "startTime": "2026-09-25T14:59:00Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-25T15:00:00Z",
          "endUtcOffset": "32400s",
          "civilStartTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 59 }
          },
          "civilEndTime": {
            "date": { "year": 2026, "month": 9, "day": 26 },
            "time": {}
          }
        },
        "activeMinutesByActivityLevel": [
          { "activityLevel": "LIGHT", "activeMinutes": "1" }
        ]
      }
    }
    // 全 216 件中先頭 1 件に絞った。以下省略。
  ]
}
```

```jsonc
// distance
{
  "dataPoints": [
    {
      "dataSource": {
        "recordingMethod": "PASSIVELY_MEASURED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "distance": {
        "interval": {
          "startTime": "2026-09-25T14:58:00Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-25T14:59:00Z",
          "endUtcOffset": "32400s",
          "civilStartTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 58 }
          },
          "civilEndTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 23, "minutes": 59 }
          }
        },
        "millimeters": "1500"
      }
    }
    // 全 326 件中先頭 1 件に絞った。以下省略。
  ]
}
```

### datapoints exercise (実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q datapoints exercise --from 2026-09-19 --to 2026-09-26` (Pixel Watch 4)。CLI の実出力 (`{"dataPoints": [...]}` の形で `nextPageToken` は含まない)。全 26 件のうち `exerciseType` が異なる先頭 2 件 (`CARDIO_WORKOUT`・`WEIGHTLIFTING`) を掲載した。`metricsSummary` はそのまま残した。

```jsonc
{
  "dataPoints": [
    {
      "name": "users/1173016576421350648/dataTypes/exercise/dataPoints/3326913505930631984",
      "dataSource": {
        "recordingMethod": "PASSIVELY_MEASURED",
        "device": { "formFactor": "WATCH", "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "exercise": {
        "interval": {
          "startTime": "2026-09-25T00:33:29Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-25T00:55:12Z",
          "endUtcOffset": "32400s"
        },
        "exerciseType": "CARDIO_WORKOUT",
        "metricsSummary": {
          "caloriesKcal": 202,
          "averageHeartRateBeatsPerMinute": "115",
          "activeZoneMinutes": "19",
          "heartRateZoneDurations": {
            "lightTime": "300s",
            "moderateTime": "900s",
            "vigorousTime": "120s",
            "peakTime": "0s"
          }
        },
        "exerciseMetadata": {},
        "displayName": "アクティビティ",
        "activeDuration": "1303s",
        "updateTime": "2026-09-25T02:17:18.107531Z",
        "createTime": "2026-09-25T02:17:18.107531Z"
      }
    },
    {
      "name": "users/1173016576421350648/dataTypes/exercise/dataPoints/7140869748721445965",
      "dataSource": {
        "recordingMethod": "ACTIVELY_MEASURED",
        "device": { "formFactor": "WATCH", "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "exercise": {
        "interval": {
          "startTime": "2026-09-24T23:00:33Z",
          "startUtcOffset": "32400s",
          "endTime": "2026-09-24T23:58:24Z",
          "endUtcOffset": "32400s"
        },
        "exerciseType": "WEIGHTLIFTING",
        "metricsSummary": {
          "caloriesKcal": 440,
          "averageHeartRateBeatsPerMinute": "107",
          "activeZoneMinutes": "30",
          "heartRateZoneDurations": {
            "lightTime": "1620s",
            "moderateTime": "1860s",
            "vigorousTime": "0s",
            "peakTime": "0s"
          }
        },
        "exerciseMetadata": {},
        "displayName": "ウエイトリフティング",
        "activeDuration": "3471s",
        "exerciseEvents": [
          {
            "eventTime": "2026-09-24T23:00:33Z",
            "eventUtcOffset": "32400s",
            "exerciseEventType": "START"
          },
          {
            "eventTime": "2026-09-24T23:58:24Z",
            "eventUtcOffset": "32400s",
            "exerciseEventType": "STOP"
          }
        ],
        "updateTime": "2026-09-24T23:58:27.169277Z",
        "createTime": "2026-09-24T23:06:34.378717Z"
      }
    }
    // 全 26 件中、exerciseType が異なる先頭 2 件に絞った。以下省略 (他は主に MOTORCYCLE)。
  ]
}
```

### datapoints heart-rate (実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q datapoints heart-rate --from 2026-09-25T10:00:00Z --to 2026-09-25T10:05:00Z` (Pixel Watch 4)。CLI の実出力 (`{"dataPoints": [...]}` の形で `nextPageToken` は含まない)。全 138 件中先頭 2 件。

```jsonc
{
  "dataPoints": [
    {
      "dataSource": {
        "recordingMethod": "PASSIVELY_MEASURED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "heartRate": {
        "sampleTime": {
          "physicalTime": "2026-09-25T10:04:59Z",
          "utcOffset": "32400s",
          "civilTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 19, "minutes": 4, "seconds": 59 }
          }
        },
        "beatsPerMinute": "49"
      }
    },
    {
      "dataSource": {
        "recordingMethod": "PASSIVELY_MEASURED",
        "device": { "displayName": "Pixel Watch 4" },
        "platform": "FITBIT"
      },
      "heartRate": {
        "sampleTime": {
          "physicalTime": "2026-09-25T10:04:57Z",
          "utcOffset": "32400s",
          "civilTime": {
            "date": { "year": 2026, "month": 9, "day": 25 },
            "time": { "hours": 19, "minutes": 4, "seconds": 57 }
          }
        },
        "beatsPerMinute": "50"
      }
    }
    // 全 138 件中先頭 2 件に絞った。以下省略。
  ]
}
```

### datapoints weight (実測)

取得コマンド (2026-09-27 JST 取得): `deno task -q datapoints weight --from 2026-09-01T00:00:00Z --to 2026-09-28T00:00:00Z`。全 2 件を掲載した (省略なし)。データ源は Health Planet アプリが Health Connect に書き込んだ体重で、`dataSource.platform` は `HEALTH_CONNECT`。

```json
{
  "dataPoints": [
    {
      "name": "users/1173016576421350648/dataTypes/weight/dataPoints/8107172512320991248",
      "dataSource": {
        "recordingMethod": "UNKNOWN",
        "device": {},
        "application": { "packageName": "jp.healthplanet.healthplanetapp" },
        "platform": "HEALTH_CONNECT"
      },
      "weight": {
        "sampleTime": {
          "physicalTime": "2026-09-25T22:15:10Z",
          "utcOffset": "32400s",
          "civilTime": {
            "date": { "year": 2026, "month": 9, "day": 26 },
            "time": { "hours": 7, "minutes": 15, "seconds": 10 }
          }
        },
        "weightGrams": 90200
      }
    },
    {
      "name": "users/1173016576421350648/dataTypes/weight/dataPoints/886503075782888464",
      "dataSource": {
        "recordingMethod": "UNKNOWN",
        "device": {},
        "application": { "packageName": "jp.healthplanet.healthplanetapp" },
        "platform": "HEALTH_CONNECT"
      },
      "weight": {
        "sampleTime": {
          "physicalTime": "2026-09-13T22:57:30Z",
          "utcOffset": "32400s",
          "civilTime": {
            "date": { "year": 2026, "month": 9, "day": 14 },
            "time": { "hours": 7, "minutes": 57, "seconds": 30 }
          }
        },
        "weightGrams": 88300
      }
    }
  ]
}
```

### datapoints body-fat (実測)

取得コマンド (2026-09-27 JST 取得): `deno task -q datapoints body-fat --from 2026-09-01T00:00:00Z --to 2026-09-28T00:00:00Z`。全 2 件を掲載した (省略なし)。データ源は `weight` と同じく Health Planet アプリが Health Connect に書き込んだ体脂肪率。

```json
{
  "dataPoints": [
    {
      "name": "users/1173016576421350648/dataTypes/body-fat/dataPoints/911827026476164016",
      "dataSource": {
        "recordingMethod": "UNKNOWN",
        "device": {},
        "application": { "packageName": "jp.healthplanet.healthplanetapp" },
        "platform": "HEALTH_CONNECT"
      },
      "bodyFat": {
        "sampleTime": {
          "physicalTime": "2026-09-25T22:15:10Z",
          "utcOffset": "32400s",
          "civilTime": {
            "date": { "year": 2026, "month": 9, "day": 26 },
            "time": { "hours": 7, "minutes": 15, "seconds": 10 }
          }
        },
        "percentage": 25.8
      }
    },
    {
      "name": "users/1173016576421350648/dataTypes/body-fat/dataPoints/4226214199077062968",
      "dataSource": {
        "recordingMethod": "UNKNOWN",
        "device": {},
        "application": { "packageName": "jp.healthplanet.healthplanetapp" },
        "platform": "HEALTH_CONNECT"
      },
      "bodyFat": {
        "sampleTime": {
          "physicalTime": "2026-09-13T22:57:30Z",
          "utcOffset": "32400s",
          "civilTime": {
            "date": { "year": 2026, "month": 9, "day": 14 },
            "time": { "hours": 7, "minutes": 57, "seconds": 30 }
          }
        },
        "percentage": 26.6
      }
    }
  ]
}
```

### daily-rollup total-calories (実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q daily-rollup total-calories --from 2026-09-19 --to 2026-09-25` (Pixel Watch 4)。全 7 件を掲載した (省略なし)。

```json
{
  "rollupDataPoints": [
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 25 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 26 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 3028.784634 }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 24 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 25 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 2815.163479 }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 23 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 24 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 2916.273316 }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 22 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 23 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 3435.855093 }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 21 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 22 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 2988.19035 }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 20 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 21 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 2906.124745 }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 19 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 20 },
        "time": {}
      },
      "totalCalories": { "kcalSum": 3632.937836 }
    }
  ]
}
```

### daily-rollup steps (実測)

取得コマンド (2026-09-26 JST 取得): `deno task -q daily-rollup steps --from 2026-09-19 --to 2026-09-25` (Pixel Watch 4)。CLI の実出力 (`{"rollupDataPoints": [...]}` の形で `nextPageToken` は含まない)。全 7 件中先頭 2 件。

```jsonc
{
  "rollupDataPoints": [
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 25 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 26 },
        "time": {}
      },
      "steps": { "countSum": "9525" }
    },
    {
      "civilStartTime": {
        "date": { "year": 2026, "month": 9, "day": 24 },
        "time": {}
      },
      "civilEndTime": {
        "date": { "year": 2026, "month": 9, "day": 25 },
        "time": {}
      },
      "steps": { "countSum": "6859" }
    }
    // 全 7 件中先頭 2 件に絞った。以下省略。
  ]
}
```

### エラー応答 (非 2xx 全般)

401 (実測、2026-09-26 JST 取得): `Authorization: Bearer bad` で不正なアクセストークンを渡して `datapoints` の URL を直接 curl で叩いた。

```json
{
  "error": {
    "code": 401,
    "message": "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.",
    "status": "UNAUTHENTICATED"
  }
}
```

400 (実測、2026-09-26 JST 取得): 修正前の CLI が sleep の filter に `sleep.interval.civil_start_time` (開始基準、非対応) を使って叩いた際の応答。`fieldViolations` まで載せた。

```json
{
  "error": {
    "code": 400,
    "message": "Invalid data point filter: INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER, INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER.",
    "status": "INVALID_ARGUMENT",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "INVALID_DATA_POINT_FILTER",
        "domain": "health.googleapis.com",
        "metadata": {
          "detailedReasons": "INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER,INVALID_DATA_POINT_FILTER_DATA_TYPE_MEMBER"
        }
      },
      {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        "fieldViolations": [
          {
            "field": "filter",
            "description": "Member 'sleep.interval.civil_start_time' is not supported for filtering. (at line 1, column 1)"
          },
          {
            "field": "filter",
            "description": "Member 'sleep.interval.civil_start_time' is not supported for filtering. (at line 1, column 53)"
          }
        ]
      }
    ]
  }
}
```

invalid_grant (実測、2026-09-26 JST 取得): OAuth token endpoint (`https://oauth2.googleapis.com/token`) に `refresh_token=bogus` (不正な値) を渡して叩いた応答。`datapoints`・`daily-rollup` のトークン更新失敗時もこの形で本文が返る。

```json
{
  "error": "invalid_grant",
  "error_description": "Bad Request"
}
```

429 (レート制限): 実測できていない (300 requests/minute を短時間で使い切る手段が無い)。公式ドキュメントにも 429 時の JSON 形の記載が見当たらない。`datapoints`・`daily-rollup` は非 2xx 全般を同じ経路 (HTTP ステータスと生のレスポンスボディをそのまま stderr に出力) で扱うため、429 が来ても body をそのまま出す。

## エラー時の挙動

- `datapoints` ・ `daily-rollup` ・ `/token` のいずれも、非 2xx レスポンス (429 を含む) は HTTP ステータスと生のレスポンスボディを stderr に出力し、exit code 1 で終了する。リトライしない。値を捏造しない。
- アクセストークンの更新 (refresh) に失敗した場合は、リフレッシュトークンが失効している可能性がある旨と `deno task auth` での再認可が必要な旨 (localhost に届かない端末では `auth-url` と `token <code>`) を stderr に出力し、exit code 1 で終了する。
- `token-status` はリフレッシュトークンが失効済み (残り日数 0 以下) なら再認可が必要な旨を stderr に出力し、exit code 1 で終了する。このとき JSON は出力しない。
- トークンファイルが読めない・必要なフィールドが揃っていない場合も、理由を添えて stderr に出力し exit code 1 で終了する。

## 対象外

- loms-claw 側の組み込み (`apm.yml` への追加、compose の環境変数、トークンファイルの置き場、system-prompt、再認可を促す cron)。
- Health Planet (別 skill `healthplanet`)、筋トレメニュー管理、食事ログ・PFC 計算。
- データの登録・削除、プロフィール・ペアリング済みデバイス情報の取得。
- Fitbit Web API・Google Fit (廃止済み)・Health Connect (端末内 API) を直接扱うこと。
