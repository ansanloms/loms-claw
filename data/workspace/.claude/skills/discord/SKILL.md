---
name: discord
description: >-
  Discord の REST API を curl で叩いてサーバ (ギルド) を操作する手順。メッセージの送信・取得・検索、リアクション付与、スレッドの作成・名前変更、チャンネルやメンバーの一覧・検索が対象。「Discord にメッセージを送る」「チャンネルの発言を読む」「スレッドを立てる」「スレッド名を変える」「メンバーを検索する」などで使う。
  bot トークンを Authorization の Bot ヘッダで渡し、 https://discord.com/api/v10 を叩く。トークンは環境変数 DISCORD_BOT_TOKEN から取る。メッセージ検索の API は bot に無いため、履歴を取得して jq でフィルタする。
  対象は bot トークンで操作できる範囲のサーバ機能。レート制限 (429) は自前で body の retry_after (秒) を見て待つ。ユーザ DM や OAuth が要る操作、Gateway (リアルタイム受信) は扱わない。
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
- トークンは環境変数 `DISCORD_BOT_TOKEN` から取り、 `Authorization: Bot ${DISCORD_BOT_TOKEN}` ヘッダで渡す。
  - クエリや body に直書きしない。
  - プロセス一覧・シェル履歴・アクセスログに平文が残る。
  - 会話への貼り付けやコミットも避ける。
- 変数が空のときは設定をユーザに依頼する。依頼には次の 3 点を含める。
  - 設定方法の例 (`export DISCORD_BOT_TOKEN='<token>'` 等)
  - トークンを会話に貼らない旨
  - 設定後にこちらで処理を再開する旨
  - 再開後に実行する手順の要約を添えてもよい。
  - 変数名は任意で、別名を使う場合は読み替える。
- 環境変数の供給元は呼び出し側の環境に依存する。シェルで `export` しても、それを実行したプロセスに `DISCORD_BOT_TOKEN` が届かない構成 (設定ファイル経由で別プロセスの環境に注入している等) もある。`export` の依頼で解決しない場合は、その環境でのトークン設定方法をユーザに確認する。
- 主手段の curl がトークン未設定等の前提条件で止まった場合も、同等機能の別ツール (MCP 等) へフォールバックしない。別 bot・別権限で動いている可能性があり、対象サーバの前提が崩れる。設定を依頼して待つ。
- bot が対象サーバに参加していること。操作には対応する権限 (例: メッセージ送信に Send Messages、スレッド作成に Create Public Threads) が要る。権限不足は `403 Missing Permissions` で返る。
- メンバー一覧 (`GET /guilds/{guild_id}/members`) には Privileged Gateway Intent の Server Members Intent を Developer Portal で有効化する必要がある。検索 (`/members/search`) はこの intent 無しでも通る。
- `guild_id`/`channel_id`/`message_id` は呼び出し側のコンテキスト (システムプロンプトのテンプレート変数、ユーザ提示の URL 等) から得る。
  - Discord の URL `https://discord.com/channels/{guild_id}/{channel_id}/{message_id}` の各セグメントがそれにあたる。
  - 判別できない場合はユーザに確認する。
  - 推測で組み立てない。
- 以降のコマンド例に出てくる `${GUILD_ID}`/`${CHANNEL_ID}`/`${MESSAGE_ID}`/`${EMOJI}` はプレースホルダであり、シェル変数として代入して使い回すものではない。
  - 実行時は得た値をリテラルで書き下す。
  - ツール呼び出しをまたぐとシェル変数は保持されず、次の呼び出しでは空文字に展開されて別のエンドポイントを叩く。
  - `DISCORD_BOT_TOKEN` だけは `${DISCORD_BOT_TOKEN}` のまま渡してよい。理由: 呼び出し側の環境が供給する環境変数であり、値をリテラルで書き下すとシェル履歴等に平文が残る。
- 環境に同等機能の別ツール (MCP の Discord ツール等) が同居していても、この skill が発動した場面では本手順を使う。ここでの本手順は curl + REST を指す。別ツールは別の bot・別の権限で動いている可能性があり、混用すると対象サーバや権限の前提が崩れる。

## リクエストの基本形

すべて `https://discord.com/api/v10` 配下を叩く。トークンは Authorization ヘッダで渡す。

```bash
curl -sS 'https://discord.com/api/v10/users/@me' \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}"
```

- ベース URL は `https://discord.com/api/v10`。バージョン `v10` を明示する。
- 書き込み (POST/PUT/PATCH/DELETE) で body を送るときは `-H 'Content-Type: application/json'` と `--data` を付ける。
- 応答は JSON。成功は `2xx`、失敗は `4xx`/`5xx` で `{"code": ..., "message": ...}` 形式のエラーを返す。
- snowflake ID (チャンネル・メッセージ・ユーザ等の ID) は 64bit 整数だが、文字列として扱う。`-r` で文字列のまま扱う。理由: jq で数値化すると桁落ちする。

## チャンネル一覧

```bash
curl -sS "https://discord.com/api/v10/guilds/${GUILD_ID}/channels" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.[] | {id, name, type, parent_id}'
```

- ギルド内の全チャンネルを返す。`type` は数値で表される (0 = テキスト/2 = ボイス/4 = カテゴリ/5 = アナウンス/11 = パブリックスレッド/15 = フォーラムなど)。
- スレッドはこの一覧に含まれないことがある。既存スレッドの `id` を名前から引く手順は「既存スレッドの ID 解決」を参照。

## チャンネル情報

```bash
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq '{id, name, type, topic, parent_id, nsfw}'
```

## メッセージ送信

本文を `--data` に直書きしない。改行・二重引用符・日本語混じりの本文をシェルの引用符内にそのまま埋めると JSON が壊れる (例: 本文に `"` が入ると JSON の閉じ引用符と衝突する)。本文は一時ファイルに書いてから `jq -Rs` で JSON エンコードする。

本文ファイルのパスは絶対パスをリテラルで決めて使う (例: `/tmp/discord-message.txt`)。シェル変数 (`${MESSAGE_FILE}` 等) には入れない。ファイルへの書き込みと、それを読んで送信するコマンドの実行が別々のツール呼び出しに分かれる場合、シェル変数は呼び出しの間で保持されず、次の呼び出しでは空文字に展開されて失敗する。書き込みと送信は「決めたパスの文字列そのもの」で繋ぐ。

`jq -Rs` の出力を curl に直接パイプしない。`jq -Rs` は対象ファイルを開けなかった場合でも exit 2 で失敗しつつ、標準出力に `{"content": ""}` を出すことがある。存在しないファイルを渡した場合のローカル確認 (Discord へは送っていない):。

```text
$ jq -Rs '{content: .}' /no/such/file
jq: error: Could not open file /no/such/file: No such file or directory
{
  "content": ""
}
$ echo $?
2
```

stderr にエラーを出しつつ、stdout には `content` が空文字の JSON を出して exit code `2` で終わる。直接パイプするとこの stdout がそのまま curl の `--data` に渡り、失敗が握り潰されて空メッセージが Discord に送られる。jq の出力を一旦ファイルへ落とし、終了コードと出力サイズを確認してから curl を実行する。

```bash
# /tmp/discord-message.txt は例。実際に書き込んだ絶対パスに置き換える (シェル変数にしない)
jq -Rs '{content: .}' /tmp/discord-message.txt > /tmp/discord-body.json
JQ_STATUS=$?
if [ "$JQ_STATUS" -ne 0 ] || [ ! -s /tmp/discord-body.json ]; then
  echo "本文の JSON 化に失敗した (jq exit=$JQ_STATUS)。本文ファイルの有無・パスを確認する。curl は実行しない。" >&2
else
  curl -sS -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
    -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data @/tmp/discord-body.json \
  | jq '{id, channel_id}'
fi
```

- このブロックは 1 回の実行単位 (1 つの `sh` スクリプト、または 1 回の Bash 呼び出し) として実行する。理由: `JQ_STATUS` はシェル変数なので、行ごとに別々に実行すると値が失われ、ガードが判定できなくなる。以降の分割送信・レート制限のブロックも同様に 1 回の実行単位で実行する。
- `jq -Rs` は指定ファイルの中身全体を 1 個の JSON 文字列として読み (`-R`: 生テキスト入力、`-s`: 全入力をスラープ)、改行や `"` を自動でエスケープする。
- 返信にする場合は `message_reference` を付ける。本文ファイルから同様に組み立てる: `jq -Rs --arg mid "${MESSAGE_ID}" '{content: ., message_reference: {message_id: $mid}}' /tmp/discord-message.txt > /tmp/discord-body.json` (この後の終了コード確認は上と同じ)。
- 特定ユーザへのメンションは本文 (`content` になる元テキスト) に `<@USER_ID>` を埋める。`<@...>` 自体はそのままでよい。理由: `jq -Rs` が JSON エスケープする。
- `content` は最大 2000 文字。
  - メッセージの公式ドキュメントは `"up to 2000 characters"` とのみ記載し、数え方の単位 (Unicode コードポイント・UTF-16 コード単位等) を明記していない。
  - 次の分割手順は jq の `length` (コードポイント数) で数えており、非 BMP の絵文字を多用する本文では Discord 側のカウントと乖離する可能性がある。
  - 超える場合は分割して送る (次項)。

### 2000 文字超の分割

1 メッセージの `content` は最大 2000 文字。超える本文は 2000 文字ごとに分割し、複数回に分けて送信する。1 件ずつ送信し応答を待ってから次を送る。理由: 並列に送ると Discord 側での到着順序が保証されない。さらに、チャンクごとに `429` を検知して待機・再送するところまでをループに組み込む。理由: 途中のチャンクが `429` (レート制限) で失敗すると、それを見過ごして次のチャンクへ進んでしまい欠落が生じる。

```bash
# /tmp/discord-message.txt は例。実際に書き込んだ絶対パスに置き換える (シェル変数にしない)
jq -Rsc '
  def split_by($n): if (length <= $n) then [.] else [.[0:$n]] + (.[$n:] | split_by($n)) end;
  split_by(2000)[] | {content: .}
' /tmp/discord-message.txt > /tmp/discord-chunks.jsonl
JQ_STATUS=$?

if [ "$JQ_STATUS" -ne 0 ] || [ ! -s /tmp/discord-chunks.jsonl ]; then
  echo "本文の分割に失敗した (jq exit=$JQ_STATUS)。本文ファイルの有無・パスを確認する。送信しない。" >&2
else
  while IFS= read -r body; do
    while :; do
      RAW=$(curl -sS -w '\n%{http_code}' -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages" \
        -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
        -H 'Content-Type: application/json' \
        --data "$body")
      HTTP_CODE=$(tail -n1 <<< "$RAW")
      RESPONSE_BODY=$(sed '$d' <<< "$RAW")

      if [ "$HTTP_CODE" = "429" ]; then
        RETRY_AFTER=$(jq -r '.retry_after' <<< "$RESPONSE_BODY")
        sleep "$RETRY_AFTER"
        continue
      fi

      echo "$RESPONSE_BODY" | jq '{id, channel_id}'
      break
    done
  done < /tmp/discord-chunks.jsonl
fi
```

- `split_by` は jq の `length` (Unicode コードポイント数) で 2000 文字ずつに再帰的に切り出す。単位についての注意は「メッセージ送信」の `content` の項を参照。
- `jq -Rsc` の `-c` により 1 チャンクが 1 行の JSON になるので、`while read -r` で改行を含む本文でも安全に 1 チャンクずつ取り出せる。
- 分割位置は文字数で機械的に決まるため、文や単語の途中で切れることがある。読みやすさが必要ならチャンク境界を調整してよいが、まず 2000 文字制限を超えないことを優先する。
- 上と同じ理由で、`jq` の出力は直接 curl へパイプせずファイルへ落とし、終了コードとファイルサイズを確認してから送信ループに入る。失敗時はループに入らず何も送らない。
- 内側の `while :; do ... done` は 1 チャンクの送信を表す。
  - `429` を受けている間はそのチャンクを送り直し、成功して初めて次のチャンクへ進む。
  - これにより欠落なく順序を保つ。
  - 外側の `while read` ループも直列実行なので、前のチャンク (再試行を含む) が完了してから次を送る。

## メッセージ取得 (履歴)

```bash
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=50" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.[] | {id, author: .author.username, content, ts: .timestamp}'
```

- `limit` は 1〜100 (既定 50)。新しい順に返る。
- ページングは `before`/`after`/`around` にメッセージ ID を渡す。さらに過去をたどるなら最古のメッセージ ID を `before` に渡して再取得する。

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
- `contains` は部分一致。検索語 `bot` は `Bottom` のような語にもマッチする。語単位で絞るなら正規表現で語境界を指定する (例: `select(.content | test("\\bbot\\b"; "i"))`。語境界は `\\b` とエスケープして書く。理由: jq 文字列内である)。
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
- Unicode 絵文字は URL エンコードする。理由: そのままだと URL に置けない。
- カスタム絵文字は `name:id` 形式 (例: `partyparrot:123456789012345678`) を URL エンコードして渡す。
- 成功時は `204 No Content` (body 無し)。`jq` には流さず、上の例のように `-o /dev/null -w '%{http_code}'` で状態コードを確認する (`204` なら成功)。理由: body が無い。

## スレッド作成 (チャンネル直下)

開始メッセージを持たない新規スレッドを作る。`type` が必須。

```bash
curl -sS -X POST "https://discord.com/api/v10/channels/${CHANNEL_ID}/threads" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
  -H 'Content-Type: application/json' \
  --data '{"name": "スレッド名", "type": 11, "auto_archive_duration": 1440}' \
| jq '{id, name, parent_id}'
```

- `name` は必須 (1〜100 文字)。ユーザの依頼から名前が決まらない場合は推測で発明せず、ユーザに確認する (後から名前変更できる旨を添えてよい)。
- `type` は `11` か `12` のいずれか。`11` はパブリックスレッド、`12` はプライベートスレッドを指す。
- `auto_archive_duration` は分単位で `60`/`1440`/`4320`/`10080` のいずれか (既定 1440 = 24 時間)。
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

## 既存スレッドの ID 解決

作成時の応答が無い (別のセッションで作られた等) 既存スレッドを名前から引く。

### アクティブなスレッド

```bash
curl -sS "https://discord.com/api/v10/guilds/${GUILD_ID}/threads/active" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.threads[] | select(.name == "対象のスレッド名") | {id, name, parent_id}'
```

- 応答は配列ではなく `{"threads": [...], "members": [...]}` のオブジェクト。スレッド本体は `threads` フィールドの配列に入っている。`jq '.[]'` のように配列として叩くと空振りする。
- `members` は各スレッドに対応する thread member オブジェクトの配列。
- ギルド内の全アクティブスレッド (公開・非公開とも) を `id` の降順で返す。アーカイブ済みスレッドはここに含まれない。

### アーカイブ済みのスレッド

アーカイブ済みのスレッドはギルド単位ではなくチャンネル単位で取得する。

```bash
# 公開アーカイブスレッド (Read Message History 権限が要る)
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/threads/archived/public" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.threads[] | select(.name == "対象のスレッド名") | {id, name}'

# 非公開アーカイブスレッド (Read Message History と Manage Threads の両方の権限が要る)
curl -sS "https://discord.com/api/v10/channels/${CHANNEL_ID}/threads/archived/private" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| jq -r '.threads[] | select(.name == "対象のスレッド名") | {id, name}'
```

- こちらも応答は `{"threads": [...], "members": [...], "has_more": ...}` のオブジェクト。`has_more` が `true` なら未取得の古いスレッドが残っている。
- ページングの `before` はここでは ISO8601 タイムスタンプで、「このタイムスタンプより前にアーカイブされたスレッド」を返す。snowflake をそのまま渡さない。理由:「メッセージ取得 (履歴)」や「メッセージ検索」の `before` (メッセージ ID の snowflake) とは型が違う。
- 名前が一致するスレッドが複数見つかった場合、どれが対象か推測せずユーザに確認する。

## スレッド名の変更

`PATCH /channels/{thread_id}` で名前を変える。理由: スレッドはチャンネルの一種である。`thread_id` はスレッド作成時に返った `id`。メッセージ派生スレッドなら `thread_id` = 起点メッセージの `id` になる (作成応答の `id` で確認できる)。作成応答が無い既存スレッドの `id` は「既存スレッドの ID 解決」で引く。

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
- 出力の表示名は、ニックネーム `nick`、アカウント表示名 `global_name`、ユーザ名 `username` の順で解決する。先にあるものを優先する。
- こちらは Server Members Intent 無しでも通る。

## レート制限

自前で対処する。理由: discord.js のような自動キューは無い。

- 制限超過は `429 Too Many Requests`。応答 body は `{"message": "You are being rate limited.", "retry_after": 0.75, "global": false}`。`retry_after` は秒。
- 応答ヘッダ `X-RateLimit-Remaining` が残り回数、`X-RateLimit-Reset-After` が回復までの秒数。`-D -` でヘッダを見られる。
- `429` の応答には標準の `Retry-After` ヘッダも付く。
  - body の `retry_after` と同じ待機時間を表すが、`Retry-After` は秒に切り上げた整数である。
  - 小数の待機時間をそのまま使いたい場合は body の `retry_after` を見る。
  - この skill では body の `retry_after` を基準にする。
- `429` を受けたら `retry_after` 秒待ってから再試行する。多数のリクエストを連続で投げない。

```bash
# ヘッダでレート状況を確認する
curl -sS -D - -o /dev/null "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}" \
| grep -i 'x-ratelimit'
```

```bash
# 例: GET リクエストで 429 を検知し、body の retry_after 秒だけ待って再試行する
# (この形はどのエンドポイントにも使える。書き込み系で body を送る場合は --data を追加する)
RAW=$(curl -sS -w '\n%{http_code}' "https://discord.com/api/v10/channels/${CHANNEL_ID}" \
  -H "Authorization: Bot ${DISCORD_BOT_TOKEN}")
HTTP_CODE=$(tail -n1 <<< "$RAW")
RESPONSE_BODY=$(sed '$d' <<< "$RAW")

if [ "$HTTP_CODE" = "429" ]; then
  RETRY_AFTER=$(jq -r '.retry_after' <<< "$RESPONSE_BODY")
  sleep "$RETRY_AFTER"
  # ここで同じリクエストを再送する
fi
```

- `sleep` は GNU coreutils であれば `0.75` のような小数秒をそのまま受け付ける。
- `-w '\n%{http_code}'` で本文の末尾にステータスコードを追記させ、`tail`/`sed` で分離する (`-D -` でヘッダから読んでもよい)。
- メッセージ送信のように `--data` で body を送るリクエストで同じことをする場合の完全な例は、「2000 文字超の分割」の送信ループを参照 (チャンクごとに同じ 429 検知・待機・再送をしている)。

## 異常系 (401/404/5xx)

`2xx` 以外の応答は body の `{"code": ..., "message": ...}` を確認し、ステータスコードに応じて次のように扱う。

- **401 Unauthorized**: トークンが無効・失効している。前提条件のトークン入手手順に従い、ユーザに再設定を依頼する。再試行しても直らない。
- **403 Forbidden**: 権限不足、または bot が対象サーバ/チャンネルにいない (各操作の説明を参照)。再試行しても直らない。
- **404 Not Found**: 指定した `guild_id`/`channel_id`/`message_id` が存在しないか、bot からアクセスできない。ID を疑い、呼び出し側のコンテキストと突き合わせる。推測で別の ID を試さない。
- **429 Too Many Requests**: 上記のレート制限を参照。
- **5xx (500/502/503/504)**: Discord 側の一時的な障害。数秒待って 1〜2 回まで再試行し、直らなければユーザに報告する (無限リトライしない)。

## 注意

- トークンの扱いは「前提条件」を参照。
- snowflake ID の扱いは「リクエストの基本形」を参照。
- メッセージ検索の API 不在は「メッセージ検索 (履歴の取得 + フィルタ)」を参照。
- 絵文字の URL エンコードは「リアクション付与」を参照。
- スレッド作成の引数差は「スレッド作成 (チャンネル直下)」と「スレッド作成 (メッセージから派生)」を参照。スレッド名等の必須パラメータがユーザの依頼から決まらない場合は、どちらの作成手順でも推測で発明せずユーザに確認する。最終的な値だけが判明している場合 (例: 変更後の名前だけ指定された) は、その値で最初から作成して後続の変更を省く選択肢を併せて提示する。
- 取得・操作した内容をユーザに示す際は対象のチャンネル・メッセージを明示する。値を捏造しない。
