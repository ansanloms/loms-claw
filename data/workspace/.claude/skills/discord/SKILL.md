---
name: discord
description: >-
  Discord の REST API を curl で叩いてサーバ (ギルド) を操作する手順。メッセージの送信・取得・検索、リアクション付与、スレッドの作成・名前変更、チャンネルやメンバーの一覧・検索が対象。「Discord にメッセージを送る」「チャンネルの発言を読む」「スレッドを立てる」「スレッド名を変える」「メンバーを検索する」などで使う。
  bot トークンを Authorization の Bot ヘッダで渡し、 https://discord.com/api/v10 を叩く。トークンは環境変数 DISCORD_BOT_TOKEN から取る。メッセージ検索の API は bot に無いため、履歴を取得して jq でフィルタする。
  対象は bot トークンで操作できる範囲のサーバ機能。レート制限 (429) は自前で Retry-After を見て待つ。ユーザ DM や OAuth が要る操作、Gateway (リアルタイム受信) は扱わない。
---

# Discord REST API 操作

Discord の REST API を curl で叩き、サーバ (ギルド) のチャンネル・メッセージ・スレッド・メンバーを操作する手順。実体は `https://discord.com/api/v10` で、bot トークンを使う。bot トークンで通常の Bot ができる範囲を対象とし、ユーザ DM・OAuth 専用エンドポイント・Gateway (WebSocket でのリアルタイムイベント受信) は扱わない。

## 情報源

- API リファレンス: <https://discord.com/developers/docs/reference>
- チャンネル: <https://discord.com/developers/docs/resources/channel>
- メッセージ: <https://discord.com/developers/docs/resources/message>
- ギルド (メンバー含む): <https://discord.com/developers/docs/resources/guild>
- レート制限: <https://discord.com/developers/docs/topics/rate-limits>

## 前提条件

- bot トークンが要る。Discord Developer Portal の Bot ページで発行する (`Bot <token>` の `<token>` 部分)。
- トークンは環境変数 `DISCORD_BOT_TOKEN` から取り、 `Authorization: Bot ${DISCORD_BOT_TOKEN}` ヘッダで渡す。クエリや body に直書きしない。プロセス一覧・シェル履歴・アクセスログに平文が残る。会話への貼り付けやコミットも避ける。
- 変数が空のときは設定をユーザに依頼する。変数名は任意で、別名を使う場合は読み替える。
- bot が対象サーバに参加していること。操作には対応する権限 (例: メッセージ送信に Send Messages、スレッド作成に Create Public Threads) が要る。権限不足は `403 Missing Permissions` で返る。
- メンバー一覧 (`GET /guilds/{guild_id}/members`) には Privileged Gateway Intent の**Server Members Intent**を Developer Portal で有効化する必要がある。検索 (`/members/search`) はこの intent 無しでも通る。
- `guild_id` / `channel_id` / `message_id` は呼び出し側のコンテキスト (システムプロンプトのテンプレート変数、ユーザ提示の URL 等) から得る。Discord の URL `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}` の各セグメントがそれにあたる。判別できない場合はユーザに確認する。推測で組み立てない。

## リクエストの基本形

すべて `https://discord.com/api/v10` 配下を叩く。トークンは Authorization ヘッダで渡す。

```bash
curl -sS 'https://discord.com/api/v10/users/@me' \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}"
```

- ベース URL は `https://discord.com/api/v10`。バージョン `v10` を明示する。
- 書き込み (POST / PUT / PATCH / DELETE) で body を送るときは `-H 'Content-Type: application/json'` と `--data` を付ける。
- 応答は JSON。成功は `2xx`、失敗は `4xx` / `5xx` で `{"code": ..., "message": ...}` 形式のエラーを返す。
- snowflake ID (チャンネル・メッセージ・ユーザ等の ID) は 64bit 整数だが、文字列として扱う。jq で数値化すると桁落ちするので `-r` で文字列のまま扱う。

## チャンネル一覧

```bash
curl -sS "https://discord.com/api/v10/guilds/${GUILD_ID}/channels" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.[] | {id, name, type, parent_id}'
```

- ギルド内の全チャンネルを返す。`type` は数値で表される (0 = テキスト / 2 = ボイス / 4 = カテゴリ / 5 = アナウンス / 11 = パブリックスレッド / 15 = フォーラムなど)。
- スレッドはこの一覧に含まれないことがある。アクティブなスレッドは `GET /guilds/{guild_id}/threads/active` で取る。

## チャンネル情報

```bash
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq '{id, name, type, topic, parent_id, nsfw}'
```

## メッセージ送信

```bash
curl -sS -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"content": "送信内容"}' \
| jq '{id, channel_id}'
```

- `content` は最大 2000 文字。超える場合は分割する。
- 返信にする場合は `message_reference` を付ける: `{"content": "...", "message_reference": {"message_id": "..."}}`。
- 特定ユーザへのメンションは `content` に `<@USER_ID>` を埋める。

## メッセージ取得 (履歴)

```bash
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=50" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.[] | {id, author: .author.username, content, ts: .timestamp}'
```

- `limit` は 1〜100 (既定 50)。新しい順に返る。
- ページングは `before` / `after` / `around` にメッセージ ID を渡す。さらに過去をたどるなら最古のメッセージ ID を `before` に渡して再取得する。

## メッセージ検索 (履歴の取得 + フィルタ)

bot トークンで叩けるメッセージ検索 API は無い (検索はユーザトークンと GUI 限定)。履歴を取得して jq でフィルタする。

```bash
# 本文に特定語を含むメッセージ
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=100" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r --arg q '検索語' '.[] | select(.content | ascii_downcase | contains($q | ascii_downcase)) | {id, author: .author.username, content}'

# 特定ユーザの発言
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=100" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r --arg uid 'USER_ID' '.[] | select(.author.id == $uid) | {id, content}'
```

- 1 回で取れるのは直近 100 件まで。マッチが見つからない場合でも、それより古いメッセージにある可能性がある。`before` で遡って追加取得する。
- `contains` は部分一致。検索語 `bot` は `Bottom` のような語にもマッチする。語単位で絞るなら正規表現で語境界を指定する (例: `select(.content | test("\\bbot\\b"; "i"))`。jq 文字列内なので語境界は `\\b` とエスケープして書く)。
- 大量に遡るとレート制限に当たる。必要な範囲に絞る。

## 単一メッセージ取得

```bash
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq '{id, author: .author, content, timestamp, edited_timestamp, attachments, reactions}'
```

## リアクション付与

```bash
# Unicode 絵文字は URL エンコードして渡す
EMOJI=$(printf '%s' '👍' | jq -sRr @uri)
curl -sS -X PUT -o /dev/null -w '%{http_code}\n' \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/reactions/${EMOJI}/@me" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}"
```

- 末尾の `@me` は bot 自身のリアクションを表す。
- Unicode 絵文字はそのままだと URL に置けないので URL エンコードする。
- カスタム絵文字は `name:id` 形式 (例: `partyparrot:123456789012345678`) を URL エンコードして渡す。
- 成功時は `204 No Content` (body 無し)。body が無いので `jq` には流さず、上の例のように `-o /dev/null -w '%{http_code}'` で状態コードを確認する (`204` なら成功)。

## スレッド作成 (チャンネル直下)

開始メッセージを持たない新規スレッドを作る。`type` が必須。

```bash
curl -sS -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/threads" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"name": "スレッド名", "type": 11, "auto_archive_duration": 1440}' \
| jq '{id, name, parent_id}'
```

- `name` は必須 (1〜100 文字)。
- `type` は `11` (パブリックスレッド) か `12` (プライベートスレッド)。
- `auto_archive_duration` は分単位で `60` / `1440` / `4320` / `10080` のいずれか (既定 1440 = 24 時間)。
- 作成権限は Create Public Threads (プライベートは Create Private Threads)。
- スレッドにメッセージを送るには、返った `id` を `channel_id` として「メッセージ送信」を叩く。

## スレッド作成 (メッセージから派生)

既存メッセージを開始点にスレッドを派生させる。Discord UI の「メッセージからスレッドを作成」と同等で、対象メッセージが起点として残る。

```bash
curl -sS -X POST \
  "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/threads" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"name": "派生スレッド名", "auto_archive_duration": 1440}' \
| jq '{id, name, parent_id}'
```

- この形では `type` を指定しない (親メッセージのチャンネル種別から決まる)。
- 返るスレッドの `id` は起点メッセージの `id` と同じになる (派生スレッドは起点メッセージの snowflake を引き継ぐ)。ID の取り違えではない。
- 既にスレッドが付いているメッセージへ再度叩くとエラーになる。

## スレッド名の変更

スレッドはチャンネルの一種なので、`PATCH /channels/{thread_id}` で名前を変える。`thread_id` はスレッド作成時に返った `id`。

```bash
curl -sS -X PATCH "https://discord.com/api/v10/channels/${THREAD_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"name": "新しいスレッド名"}' \
| jq '{id, name, parent_id}'
```

- `name` は 1〜100 文字。
- 同じ `PATCH /channels/{thread_id}` で `archived` (`true` でアーカイブ)、`locked`、`auto_archive_duration` も変更できる。
- 名前変更には対象スレッドへの編集権限が要る。作成者は自分のスレッドを変更でき、他者のスレッドや `locked` の操作には Manage Threads 権限が要る。権限不足は `403` で返る。

## メンバー一覧

```bash
curl -sS "https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=100" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.[] | {id: .user.id, username: .user.username, global_name: .user.global_name, nick, bot: .user.bot}'
```

- `limit` は 1〜1000 (既定 1)。多人数のサーバでは `after` に最後のユーザ ID を渡してページングする。
- Server Members Intent が無いと `403` になる (前提条件を参照)。

## メンバー検索

```bash
curl -sS "https://discord.com/api/v10/guilds/${GUILD_ID}/members/search?query=loms&limit=10" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.[] | {id: .user.id, username: .user.username, global_name: .user.global_name, nick}'
```

- `query` はユーザ名・ニックネーム・表示名 (`global_name`) のいずれかへの前方一致。ユーザ名が前方一致しなくても、ニックネームや表示名が前方一致すればヒットする。`limit` は 1〜1000 (既定 1)。
- 出力の表示名は、ニックネーム (`nick`)、アカウント表示名 (`global_name`)、ユーザ名 (`username`) の順で解決する (先にあるものを優先)。
- こちらは Server Members Intent 無しでも通る。

## レート制限

discord.js のような自動キューは無いので、自前で対処する。

- 制限超過は `429 Too Many Requests`。応答 body は `{"message": "You are being rate limited.", "retry_after": 0.75, "global": false}`。`retry_after` は秒。
- 応答ヘッダ `X-RateLimit-Remaining` が残り回数、`X-RateLimit-Reset-After` が回復までの秒数。`-D -` でヘッダを見られる。
- `429` を受けたら `retry_after` 秒待ってから再試行する。多数のリクエストを連続で投げない。

```bash
# ヘッダでレート状況を確認する
curl -sS -D - -o /dev/null "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| grep -i 'x-ratelimit'
```

## 注意

- トークンは秘密情報。Authorization ヘッダと環境変数参照で渡し、コマンドラインや body・ログに平文を残さない。
- snowflake ID は文字列として扱う。jq で数値化 (`tonumber`) すると桁落ちする。
- メッセージ検索の API は bot に無い。履歴取得 + jq フィルタで代替し、直近 100 件を超える検索は `before` で遡る。
- リアクションの絵文字は URL エンコードする。カスタム絵文字は `name:id` 形式で渡す。
- スレッド作成はチャンネル直下版が `type` 必須、メッセージ派生版が `type` 不要と引数が異なる。名前変更は `PATCH /channels/{thread_id}`。
- 取得・操作した内容をユーザに示す際は対象のチャンネル・メッセージを明示する。値を捏造しない。
