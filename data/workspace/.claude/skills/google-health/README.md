# google-health

Google Health API (REST v4) から、Fitbit・Pixel Watch が記録した歩数・運動・消費カロリー・心拍・睡眠・体重・体脂肪率を取得し、食事の記録など書き込み系のデータ型を登録する skill。

## できること

OAuth2 の認可コードフローで Google Health API と連携する。`auth` は認可 URL の表示から localhost でのコード受信・トークン交換・保存までを 1 コマンドで実行する。localhost に届かない環境向けの手動退路として `auth-url` + `token` がある。

アクセストークンの期限切れを自動検出し、リフレッシュトークンで更新してからデータ取得・登録・更新・削除する。リフレッシュトークンの残り日数は `token-status` で確認できる。理由: Testing 状態のリフレッシュトークンは同意から 7 日で失効する。

読み取りでは、歩数・Active Minutes・Active Zone Minutes・距離・運動セッション・心拍・睡眠・体重・体脂肪率の記録を `datapoints` で取得する。総消費カロリーなど 14 日上限のある集計データは `daily-rollup` で取得する。表に無いデータ型も含めて任意の型を読める汎用コマンドとして `get` ・ `rollup` がある。食品マスタ (`food`、読み取り専用) も参照できる。

書き込みでは、汎用コマンド `create` ・ `update` ・ `batch-delete` で、食事の記録 (`nutrition-log`) など書き込み系のデータ型を登録・更新・削除する。

## 限界

プロフィール・ペアリング済みデバイス情報の取得・変更には対応しない。書き込みは writeonly スコープの制約により、自分が書いたデータの編集・削除のみ可能で、他ソース由来のデータは編集・削除できない。`update` は現状サーバ側の 500 で機能しない (2026-09-27 実測)。訂正は削除して再登録する。

初回はユーザ自身がブラウザで認可する必要がある (完全な自動化はできない)。`auth` はブラウザが実行環境の localhost に届くことが前提で、WSL2 なら Windows 側のブラウザから届く。届かない環境では `auth-url` + `token` の手動手順を使う。リフレッシュトークンは同意から 7 日で失効し、7 日ごとの再認可が要る。理由: OAuth 同意画面が Testing (External) 前提である。

レート制限はユーザ単位 300 requests/minute。

Fitbit Web API を直接叩く用途・Google Fit・Health Connect の代替ではない。Google Fit は廃止済みで、Health Connect は端末内 API でサーバから読めない。データ源は Fitbit と Pixel Watch が中心である。ただし体重・体脂肪率は Health Connect 経由 (Health Planet アプリ由来) でも取得できる。

## 発動する場面

「歩数」「今日の運動」「消費カロリー」「心拍」「睡眠時間」「体重」「体脂肪率」「Fitbit」「Pixel Watch」「Google Health」「食事の記録」「食事を登録」「食事を削除」「記録を消して」「摂取カロリー」などを聞かれたとき。

## 導入

```sh
apm install ansanloms/skills/google-health --target claude
```

初回認可の前に `GOOGLE_HEALTH_TOKEN_PATH` の親ディレクトリを作成しておく (例: `mkdir -p -m 700 ~/.local/state/google-health`)。

詳細は [SKILL.md](./SKILL.md) を参照。
