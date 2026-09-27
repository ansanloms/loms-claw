# google-health

Google Health API (REST v4) から、Fitbit・Pixel Watch が記録した歩数・運動・消費カロリー・心拍・睡眠・体重・体脂肪率を取得し、食事の記録など書き込み系のデータ型を登録する skill。

## できること

- OAuth2 の認可コードフローで Google Health API と連携
  - `auth`: 認可 URL の表示から localhost でのコード受信・トークン交換・保存までを 1 コマンドで実行
  - `auth-url` + `token`: localhost に届かない環境向けの手動退路
- アクセストークンの期限切れを自動検出し、リフレッシュトークンで更新してからデータ取得・登録・更新・削除
- 歩数・Active Minutes・Active Zone Minutes・距離・運動セッション・心拍・睡眠・体重・体脂肪率の記録を取得 (`datapoints`)
- 総消費カロリーなど 14 日上限のある集計データを取得 (`daily-rollup`)
- 表に無いデータ型も含めて任意の型を読める汎用コマンド (`get` ・ `rollup`)
- 食品マスタ (`food`、読み取り専用) の参照
- 食事の記録 (`nutrition-log`) など書き込み系のデータ型を登録・更新・削除する汎用コマンド (`create` ・ `update` ・ `batch-delete`)
- リフレッシュトークンの残り日数の確認 (`token-status`)。理由: Testing 状態のリフレッシュトークンは同意から 7 日で失効する

## 限界

- プロフィール・ペアリング済みデバイス情報の取得・変更には対応しない。
- 書き込みは writeonly スコープの制約により、自分が書いたデータの編集・削除のみ可 (他ソース由来のデータは編集・削除できない)。
- 初回はユーザ自身がブラウザで認可する必要がある (完全な自動化はできない)。`auth` はブラウザが実行環境の localhost に届くことが前提 (WSL2 なら Windows 側のブラウザから届く)。届かない環境では `auth-url` + `token` の手動手順を使う。
- OAuth 同意画面が Testing (External) 前提のため、リフレッシュトークンは同意から 7 日で失効する。7 日ごとの再認可が要る。
- レート制限はユーザ単位 300 requests/minute。
- Fitbit Web API を直接叩く用途・Google Fit (廃止済み)・Health Connect (端末内 API) の代替ではなく、データ源は Fitbit と Pixel Watch が中心。ただし体重・体脂肪率は Health Connect 経由 (Health Planet アプリ由来) でも取得できる。
- `update` は現状サーバ側の 500 で機能しない (2026-09-27 実測)。訂正は削除して再登録する。

## 発動する場面

「歩数」「今日の運動」「消費カロリー」「心拍」「睡眠時間」「体重」「体脂肪率」「Fitbit」「Pixel Watch」「Google Health」「食事の記録」「食事を登録」「食事を削除」「摂取カロリー」などを聞かれたとき。

## 導入

```sh
apm install ansanloms/skills/google-health --target claude
```

初回認可の前に `GOOGLE_HEALTH_TOKEN_PATH` の親ディレクトリを作成しておく (例: `mkdir -p -m 700 ~/.local/state/google-health`)。

詳細は [SKILL.md](./SKILL.md) を参照。
