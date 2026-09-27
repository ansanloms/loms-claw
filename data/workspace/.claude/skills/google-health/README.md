# google-health

Google Health API (REST v4) から、Fitbit・Pixel Watch が記録した歩数・運動・消費カロリー・心拍・睡眠・体重・体脂肪率を取得する skill。

## できること

- OAuth2 の認可コードフローで Google Health API と連携
  - `auth`: 認可 URL の表示から localhost でのコード受信・トークン交換・保存までを 1 コマンドで実行
  - `auth-url` + `token`: localhost に届かない環境向けの手動退路
- アクセストークンの期限切れを自動検出し、リフレッシュトークンで更新してからデータ取得
- 歩数・Active Minutes・Active Zone Minutes・距離・運動セッション・心拍・睡眠・体重・体脂肪率の記録を取得 (`datapoints`)
- 総消費カロリーなど 14 日上限のある集計データを取得 (`daily-rollup`)
- リフレッシュトークンの残り日数の確認 (`token-status`)。理由: Testing 状態のリフレッシュトークンは同意から 7 日で失効する

## 限界

- データの登録・削除、プロフィール・ペアリング済みデバイス情報の取得には対応しない (取得専用)。
- 初回はユーザ自身がブラウザで認可する必要がある (完全な自動化はできない)。`auth` はブラウザが実行環境の localhost に届くことが前提 (WSL2 なら Windows 側のブラウザから届く)。届かない環境では `auth-url` + `token` の手動手順を使う。
- OAuth 同意画面が Testing (External) 前提のため、リフレッシュトークンは同意から 7 日で失効する。7 日ごとの再認可が要る。
- レート制限はユーザ単位 300 requests/minute。
- Fitbit Web API を直接叩く用途・Google Fit (廃止済み)・Health Connect (端末内 API) の代替ではなく、データ源は Fitbit と Pixel Watch のみ。

## 発動する場面

「歩数」「今日の運動」「消費カロリー」「心拍」「睡眠時間」「体重」「体脂肪率」「Pixel Watch」「Google Health」などを聞かれたとき。

## 導入

```sh
apm install ansanloms/skills/google-health --target claude
```

初回認可の前に `GOOGLE_HEALTH_TOKEN_PATH` の親ディレクトリを作成しておく (例: `mkdir -p -m 700 ~/.local/state/google-health`)。

詳細は [SKILL.md](./SKILL.md) を参照。
