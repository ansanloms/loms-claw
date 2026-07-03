# discord

Discord の REST API を curl で叩いてサーバ (ギルド) を操作する skill。`https://discord.com/api/v10` を bot トークンで利用する。

## できること

- メッセージの送信・取得・検索 (検索 API は bot に無いため、履歴を取得して jq でフィルタ)
- リアクション付与
- スレッドの作成・名前変更
- チャンネルやメンバーの一覧・検索

bot トークンは Authorization の Bot ヘッダで渡す。トークンは環境変数 `DISCORD_BOT_TOKEN` から取る。レート制限 (429) は `Retry-After` を見て自前で待つ。

## 対象外

- ユーザ DM や OAuth が要る操作
- Gateway (リアルタイム受信)

## 発動する場面

「Discord にメッセージを送る」「チャンネルの発言を読む」「スレッドを立てる」「スレッド名を変える」「メンバーを検索する」など。

## 導入

```sh
apm install ansanloms/skills/discord --target claude
```

詳細は [SKILL.md](./SKILL.md) を参照。
