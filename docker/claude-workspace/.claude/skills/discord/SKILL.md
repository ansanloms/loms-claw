---
name: discord
description: Discord REST API のリファレンス。メッセージ送信、チャンネル操作、メンバー検索など Discord を操作するときに参照する。
user-invocable: false
---

# Discord REST API

Bot プロセス内で動作する内部 REST API。Discord の情報取得・操作に使う。

ベース URL: `http://127.0.0.1:3000`

## エンドポイント一覧

### チャンネル一覧

```
GET /discord/channels?type=text|voice|category|all
```

type 省略時は all。

### チャンネル情報

```
GET /discord/channels/{channel_id}
```

### メッセージ送信

```
POST /discord/channels/{channel_id}/messages
Content-Type: application/json

{"content": "送信内容"}
```

### メッセージ検索

```
GET /discord/channels/{channel_id}/messages?query=検索語&author_id=ユーザーID&limit=25
```

全パラメータ省略可。limit は 1-100（デフォルト 25）。

### メッセージ取得

```
GET /discord/channels/{channel_id}/messages/{message_id}
```

### リアクション追加

```
POST /discord/channels/{channel_id}/messages/{message_id}/reactions
Content-Type: application/json

{"emoji": "👍"}
```

### メンバー一覧/検索

```
GET /discord/members?query=検索語&limit=25
```

全パラメータ省略可。limit は 1-100（デフォルト 25）。

## curl 使用例

```bash
# チャンネル一覧（テキストのみ）
curl -s 'http://127.0.0.1:3000/discord/channels?type=text'

# メッセージ送信
curl -s -X POST http://127.0.0.1:3000/discord/channels/{channel_id}/messages \
  -H 'Content-Type: application/json' \
  -d '{"content": "hello"}'

# メッセージ検索
curl -s 'http://127.0.0.1:3000/discord/channels/{channel_id}/messages?query=keyword&limit=10'

# リアクション追加
curl -s -X POST http://127.0.0.1:3000/discord/channels/{channel_id}/messages/{message_id}/reactions \
  -H 'Content-Type: application/json' \
  -d '{"emoji": "👍"}'

# メンバー検索
curl -s 'http://127.0.0.1:3000/discord/members?query=loms'
```

## 注意事項

- レスポンスは全て JSON。
- 現在のチャンネル ID はシステムプロンプトのテンプレート変数で得られる。
- エラー時は `{"error": "メッセージ"}` 形式で返る。
- メッセージ検索は直近 limit 件を取得後にクライアント側でフィルタする。マッチが少ない場合、チャンネルにメッセージが存在しても結果が 0 件になることがある。
- メッセージ取得のリアクション情報は Bot 起動後にキャッシュされた分のみ。起動前のリアクションは含まれない場合がある。
