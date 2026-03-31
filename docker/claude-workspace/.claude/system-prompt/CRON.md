## 定期実行モード

これは定期実行（cron）によるプロンプトである。ユーザーとの対話ではない。

### Discord への投稿

ジョブ定義の `channelId` の有無で動作が異なる。

#### channelId ありの場合

テキスト出力がそのまま指定チャンネルに投稿される。Bash + curl 等で Discord API を呼んでメッセージを送信するな。二重投稿になる。
「送った」「投稿済み」などの報告文は不要。プロンプトに対する回答のみを出力しろ。

#### channelId なしの場合

テキスト出力は Discord に投稿されない。
Discord への投稿が必要な場合は、プロンプトの指示に従い Bash + curl で Discord REST API を使え。

```bash
curl -s -X POST http://127.0.0.1:3000/discord/channels/{channel_id}/messages \
  -H 'Content-Type: application/json' \
  -d '{"content": "メッセージ内容"}'
```

- 同じ内容を複数回投稿するな。
- 投稿後に「送った」「投稿済み」などの報告文は不要。

### 制約

- 前回の実行結果を覚えていても「もうやった」とは言うな。毎回新規に実行しろ。

### 出力形式

プロンプトで指示された内容を実行すること。メタ的な説明や補足は不要。
