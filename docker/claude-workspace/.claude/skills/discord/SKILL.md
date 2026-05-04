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

### スレッド作成

```
POST /discord/channels/{channel_id}/threads
Content-Type: application/json

{
  "name": "スレッド名",
  "auto_archive_duration": 1440,
  "reason": "話題分離"
}
```

テキストチャンネル直下に新しい (Public) スレッドを作る。`name` 必須。`auto_archive_duration` は 60 / 1440 / 4320 / 10080 のいずれか (省略時 1440)。`reason` は audit log に出る任意の文字列。

レスポンス: `{"id": "...", "name": "...", "parent_id": "..."}`

新しいスレッドにメッセージを送るには、レスポンスの `id` を `channel_id` として「メッセージ送信」エンドポイントを叩く。

### メッセージから派生スレッド作成

```
POST /discord/channels/{channel_id}/messages/{message_id}/threads
Content-Type: application/json

{
  "name": "派生スレッド名",
  "auto_archive_duration": 1440,
  "reason": "ユーザの発言から分岐"
}
```

既存メッセージを starter とするスレッドを派生させる。Discord UI の「メッセージから派生」と同等で、対象メッセージが thread の発端として表示されるため文脈を残したまま分離できる。

`name` 必須、その他のパラメータは「スレッド作成」と同じ。レスポンスも同じ形式。

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

# スレッド作成 (チャンネル直下)
curl -s -X POST http://127.0.0.1:3000/discord/channels/{channel_id}/threads \
  -H 'Content-Type: application/json' \
  -d '{"name": "明日の旅行", "reason": "話題分離"}'

# メッセージから派生スレッド作成
curl -s -X POST http://127.0.0.1:3000/discord/channels/{channel_id}/messages/{message_id}/threads \
  -H 'Content-Type: application/json' \
  -d '{"name": "来週の旅行", "reason": "ユーザの発言から分岐"}'

# メンバー検索
curl -s 'http://127.0.0.1:3000/discord/members?query=loms'
```

## 注意事項

- レスポンスは全て JSON。
- 現在のチャンネル ID はシステムプロンプトのテンプレート変数で得られる。
- エラー時は `{"error": "メッセージ"}` 形式で返る。
- メッセージ検索は直近 limit 件を取得後にクライアント側でフィルタする。マッチが少ない場合、チャンネルにメッセージが存在しても結果が 0 件になることがある。
- メッセージ取得のリアクション情報は Bot 起動後にキャッシュされた分のみ。起動前のリアクションは含まれない場合がある。
- スレッド作成は **Create Public Threads** 権限が bot ロールに付与されている必要がある。権限不足時は 500 エラーが返る。フォーラムチャンネルや音声チャンネルに対してスレッド作成エンドポイントを叩くと 400 が返る (現状はテキストチャンネルのみ対応)。
