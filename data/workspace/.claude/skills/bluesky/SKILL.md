---
name: bluesky
description: >-
  指定ユーザ (主に自分自身) の Bluesky の情報を公開 API から取得する手順。直近の投稿内容・関心トピック・フォローしている人・フォローされている人を把握したい際に使う。「最近何を投稿したか」「旅行の写真を見たい」「誰をフォローしているか」「フォロワーは誰か」などが対象。フォロー先の傾向から関心分野を推し量る用途にも使う。
  AT Protocol の公開 AppView (public.api.bsky.app) を認証なしで叩く。投稿は app.bsky.feed.getAuthorFeed、プロフィールと各種件数は app.bsky.actor.getProfile、フォロー/フォロワーは app.bsky.graph.getFollows / getFollowers を使う。画像はダウンロード後に ffmpeg でリサイズして表示する。
  対象は公開情報のみ。いいね一覧など認証必須のデータの取得や、投稿・フォローの作成/削除はできない。
---

# Bluesky ユーザ情報取得

指定ユーザの近況・関心・つながりを公開 API から取得する手順。AT Protocol の公開 AppView を認証なしで叩く。投稿の写真をその場で見る用途と、フォロー関係の把握を主目的とする。

## 情報源

- 公開 AppView エンドポイント (認証不要): `https://public.api.bsky.app/xrpc/...`
- 主なエンドポイント: `app.bsky.actor.getProfile` (プロフィール・各種件数)/`app.bsky.feed.getAuthorFeed` (投稿)/`app.bsky.graph.getFollows` (フォロー)/`app.bsky.graph.getFollowers` (フォロワー)
- API ドキュメント: <https://docs.bsky.app/docs/category/http-reference>

## 引数

実 API のクエリパラメータと、この skill 固有の抽象概念 (API には存在しない) を区別する。

### API パラメータ

| 引数   | 対象 API             | この skill の既定値 | 説明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------ | -------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| actor  | 全エンドポイント共通 | (必須)              | ハンドル (`<handle>`。bsky.social でもカスタムドメインでも可) または DID。そのまま渡せる (DID 解決は不要)。                                                                                                                                                                                                                                                                                                                                                                                                           |
| limit  | `getAuthorFeed` のみ | 20                  | 1 リクエストで取得する件数。**この既定値 20 は `getAuthorFeed` に限った skill の権威**であり、「取得対象の選び方」「投稿の取得」の各節はこれを参照する。API 自体の既定は 50、最大は 100 (超えるとエラー)。この skill は近況把握を主用途とするため既定を 20 に絞る。多めに集計したい場合は「関心トピックの導出」節の指示に従って上書きする。`getFollows`/`getFollowers` の `limit` はこの既定と無関係で、「フォロー・フォロワー」節を権威とする (100 以下なら `limit=100` で全件、100 超で打ち切るときは `limit=50`)。 |
| filter | `getAuthorFeed` のみ | `posts_no_replies`  | 投稿種別。既定はオリジナル + リポスト (リプライ除外)。画像目的なら `posts_with_media`。API 自体の既定は `posts_with_replies`。                                                                                                                                                                                                                                                                                                                                                                                        |

`filter` の取りうる値は `posts_with_replies` (全部)/`posts_no_replies` (既定)/`posts_with_media` (画像付きのみ)/`posts_and_author_threads` (投稿と自己スレッド)/`posts_with_video` (動画付きのみ)。

### skill 固有の概念 (API パラメータではない)

| 概念 | 説明                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 範囲 | 投稿取得を「件数」 (例: 直近 20 件。`limit` にそのまま反映) と「期間」 (例: 直近 3 日。`cursor` を辿りながら投稿時刻で打ち切る) のどちらで指定するかを表す skill 内の区分。API には無い。指定が無ければ件数指定・`limit` 既定 20 件として扱う。 |

## 取得対象の選び方

依頼に応じて必要なものだけ取得する。

- 近況・最近の投稿・写真なら、プロフィール概要と投稿の取得 (必要なら画像) を行う。
- 関心トピックなら、投稿を取得してそこから導出する。このとき取得件数は `limit` の既定 (20、「引数」節を参照) でなく「関心トピックの導出」節の推奨 (limit=50 〜 100) を使う。
- フォローしている人なら `getFollows`、フォローされている人 (フォロワー) なら `getFollowers` を使う。
- 関心分野の推察なら、投稿の話題に加えてフォロー先 (`getFollows`) の傾向も材料にする。

まずプロフィール概要を取ると、表示名・bio と各種総数 (投稿/フォロー/フォロワー) が分かり、以降のページ数の見積りに使える。

## プロフィール概要

```bash
curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile' \
  --data-urlencode 'actor=<handle>' \
| jq '{handle, displayName, description, postsCount, followsCount, followersCount}'
```

- `displayName` と `description` (bio)、`postsCount`/`followsCount`/`followersCount` の総数が返る。
- フォロー/フォロワー一覧を辿る前にこの総数を見て、何ページ必要かを見積もる。

実レスポンス例 (取得日: 2026-08-10)。取得コマンド: `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile' --data-urlencode 'actor=bsky.app' | jq '{handle, displayName, description, postsCount, followsCount, followersCount}'`

```json
{
  "handle": "bsky.app",
  "displayName": "Bluesky",
  "description": "official Bluesky account (check username👆)\n\nBugs, feature requests, feedback: support@bsky.app",
  "postsCount": 804,
  "followsCount": 11,
  "followersCount": 34456261
}
```

## 投稿の取得

基本のコマンド。`actor` にハンドルを直接渡す。

```bash
curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' \
  --data-urlencode 'actor=<handle>' \
  --data-urlencode 'limit=20' \
  --data-urlencode 'filter=posts_no_replies'
```

- `<handle>` には対象アカウントのハンドルを入れる (自分の動向把握が主目的なら自分のハンドル)。bsky.social でもカスタムドメインでも可。
- `limit` は API 自体の既定は 50、最大 100。この skill の既定は 20 (「引数」節を参照)。20 件程度の近況把握なら 1 リクエストで足りる。
- ハンドルの実在確認が要るときだけ `com.atproto.identity.resolveHandle` を使う (例: `?handle=<handle>` で `{"did":"did:plc:..."}` が返る)。通常は不要。
- ページネーションは、レスポンス末尾の `cursor` (タイムスタンプ文字列) を次回 `--data-urlencode "cursor=<値>"` に渡すと続きを取得できる。`cursor` が返らなくなったら終端である。どのエンドポイントでも 1 ページの返却数は `limit` より少ないことがあり、終端判定は件数でなく `cursor` の有無のみで行う。
- 期間指定のときは `cursor` を辿りつつ各投稿の活動時刻を見て、閾値より古くなった時点で打ち切る。閾値は現在 UTC から N 日を引いた時刻 (rolling) とし、暦日境界で切る必要があればユーザに確認する。境界が初回ページ内に収まれば `cursor` を辿らず終了してよい。活動時刻はオリジナルは `post.indexedAt`、リポストは `reason.indexedAt` を使う。`record.createdAt` はリポストでは元投稿の時刻を指すため期間判定に使わない。
- 期間指定でページを辿る際は安全上限 (目安 5 ページ/500 件) を設け、超えたら停止して「この範囲までしか確認していない」と明示する。値は捏造しない。

## 投稿の抽出と整形

`jq` で各投稿の主要フィールドを取り出す。

```bash
curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' \
  --data-urlencode 'actor=<handle>' \
  --data-urlencode 'limit=20' \
  --data-urlencode 'filter=posts_no_replies' \
| jq -r '.feed[] | {
    is_repost: (.reason."$type" == "app.bsky.feed.defs#reasonRepost"),
    time: (.reason.indexedAt // .post.indexedAt),
    author: .post.author.handle,
    text: .post.record.text,
    rkey: (.post.uri | split("/") | last),
    embed: .post.embed."$type",
    media_type: (.post.embed.media."$type" // null),
    images: [ ((.post.embed.images // .post.embed.items // .post.embed.media.images // .post.embed.media.items // [])[]) | {alt, fullsize} ],
    external: ((.post.embed.external // .post.embed.media.external) as $e | if $e then {uri: $e.uri, title: $e.title} else null end),
    counts: {like: .post.likeCount, repost: .post.repostCount, reply: .post.replyCount}
  }'
```

- `is_repost` が真なら本人による他者投稿のリポストである。`author` (= `post.author.handle`) が元投稿者なので「リポスト: @元投稿者」と区別して示す。`reason.by.handle` がリポストした本人 (= 取得対象アカウント)。
- `time` は UTC の ISO 8601。提示前に JST へ直す (例: `TZ=Asia/Tokyo date -d "<time の値>" '+%Y-%m-%d %H:%M'`)。
- embed は種別ごとに扱いを変える。
  - `app.bsky.embed.images#view` は画像。`images[]` の `fullsize`/`alt` を使う (後述「画像の取得と表示」へ)。
  - `app.bsky.embed.external#view` は外部リンク。`external.uri`/`external.title` を添える。
  - `app.bsky.embed.record#view` は引用投稿。`.post.embed.record` に引用元の本文がある。
  - `app.bsky.embed.video#view` は動画。ダウンロードは不要で「動画あり」の注記に留める。
  - `app.bsky.embed.gallery#view` は複数枚画像 (`bsky.app` 公式のカルーセル機能告知投稿の alt テキストに「carousel only shows for posts with at least 5 photos」とあり、実測でも `images#view` は 1/2/4 枚、`gallery#view` は 5 枚・10 枚の投稿で観測しておりこれと整合する。5 枚以上で `gallery#view` になる)。**`images` ではなく `items[]` にある** (各要素は `fullsize`/`alt`/`aspectRatio` に加え `thumbnail` を持つ。`images#view` の `thumb` とキー名が異なる点に注意)。上記 jq はこの位置もフォールバックで拾う。画像扱いとし、省略時の注記は「画像あり」でよい。
  - `app.bsky.embed.recordWithMedia#view` は「引用投稿 + メディア添付」の複合埋め込み。実体は `media` (`images#view`/`gallery#view`/`video#view`/`external#view` のいずれか) と `record` (引用元) の組。上記 jq の `media_type` フィールド (`.post.embed.media."$type"`) で `media` の種別を判定する。
    - `media_type` が `images#view` なら画像は `.post.embed.media.images`、`gallery#view` なら `.post.embed.media.items` にある。上記 jq の `images` フィールドはどちらの位置もフォールバックで拾う。
    - `media_type` が `external#view` なら外部リンクは `.post.embed.media.external` にある。上記 jq の `external` フィールドはこの位置もフォールバックで拾う。
    - `media_type` が `video#view` なら画像・外部リンクは無く、「動画あり」の注記に留める (`embed` フィールドだけでは判別できないため `media_type` を見る)。
    - 引用元は `.post.embed.record.record` にある (`app.bsky.embed.record#view` と同じ扱い)。
  - 上記に無い種別が来たら、`(埋め込みあり: <$type>)` の形で種別名を添えて本文のみ提示する。列挙外を理由に投稿を落とさない。

`recordWithMedia#view` (`media` が `images#view`) の実レスポンス例 (取得日: 2026-08-10。関係の無いフィールドは `…` で省略)。取得コマンド: `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' --data-urlencode 'actor=bsky.app' --data-urlencode 'limit=100' --data-urlencode 'filter=posts_with_media'` の結果から該当投稿の `.post.embed` を抜粋。

```json
{
  "$type": "app.bsky.embed.recordWithMedia#view",
  "media": {
    "$type": "app.bsky.embed.images#view",
    "images": [
      {
        "alt": "Word cloud of most-used words: rolling, accounts, posts, …",
        "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/…"
      }
    ]
  },
  "record": {
    "record": {
      "uri": "at://did:plc:…/app.bsky.feed.post/3m6mwoadjbp2d",
      "author": { "handle": "anisota.net", "…": "…" },
      "value": { "text": "Hello moths, …", "…": "…" },
      "…": "…"
    }
  }
}
```

`gallery#view` の実レスポンス例 (取得日: 2026-08-10。5 枚中 1 枚のみ抜粋)。取得コマンド: `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' --data-urlencode 'actor=bsky.app' --data-urlencode 'limit=100' --data-urlencode 'filter=posts_with_media'` の結果から該当投稿の `.post.embed` を抜粋。

```json
{
  "$type": "app.bsky.embed.gallery#view",
  "items": [
    {
      "$type": "app.bsky.embed.gallery#viewImage",
      "thumbnail": "https://cdn.bsky.app/img/feed_thumbnail/plain/…",
      "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/…",
      "alt": "We've increased the number of photos you can attach to a post from 4 to 10. …",
      "aspectRatio": { "height": 1000, "width": 1000 }
    }
  ]
}
```

`recordWithMedia#view` (`media` が `gallery#view`) の実レスポンス例 (取得日: 2026-08-10。`bsky.app` のカルーセル機能告知投稿を第三者が引用した投稿から取得。10 枚中 1 枚のみ抜粋、関係の無いフィールドは `…` で省略)。取得コマンド: まず `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getQuotes' --data-urlencode 'uri=at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mnslrkd6ok2g' --data-urlencode 'limit=100'` で該当投稿を発見し、`curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts' --data-urlencode 'uris=at://did:plc:2eexdpaaaz2ai3ymyigtceoj/app.bsky.feed.post/3moasw4lq422r'` で単体取得。

```json
{
  "$type": "app.bsky.embed.recordWithMedia#view",
  "media": {
    "$type": "app.bsky.embed.gallery#view",
    "items": [
      {
        "$type": "app.bsky.embed.gallery#viewImage",
        "thumbnail": "https://cdn.bsky.app/img/feed_thumbnail/plain/…",
        "fullsize": "https://cdn.bsky.app/img/feed_fullsize/plain/…",
        "alt": "",
        "aspectRatio": { "height": 776, "width": 1098 }
      }
    ]
  },
  "record": {
    "record": {
      "uri": "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mnslrkd6ok2g",
      "author": { "handle": "bsky.app", "…": "…" },
      "value": { "text": "v1.123 is live! …", "…": "…" },
      "…": "…"
    }
  }
}
```

`recordWithMedia#view` (`media` が `external#view`) の実レスポンス例 (取得日: 2026-08-10。関係の無いフィールドは `…` で省略)。取得コマンド: `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' --data-urlencode 'actor=bsky.app' --data-urlencode 'limit=100' --data-urlencode 'filter=posts_no_replies'` の結果から該当投稿の `.post.embed` を抜粋。

```json
{
  "$type": "app.bsky.embed.recordWithMedia#view",
  "media": {
    "$type": "app.bsky.embed.external#view",
    "external": {
      "uri": "https://kf.org/kfbluesky",
      "title": "Why Knight Foundation Invested in Bluesky - Knight Foundation"
    }
  },
  "record": {
    "record": {
      "uri": "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mhgprzgahs2l",
      "author": { "handle": "bsky.app", "…": "…" },
      "value": {
        "text": "Last April, we raised $100M in Series B funding. …",
        "…": "…"
      },
      "…": "…"
    }
  }
}
```

修正前の jq (`external: (if .post.embed.external then {...} else null end)`) はこの投稿で `external: null` を返し、外部リンクが存在ごと欠落していた。修正後 (`.post.embed.external // .post.embed.media.external` を見る) では正しく拾える。

- jq テンプレートは全フィールド版。依頼に不要なフィールド (画像不要なら `images` 等) は削ってよい。コアは `is_repost`/`time`/`author`/`text`/`rkey`。
- 提示は 2 層で考える。提示必須 = 日時 (JST)・本文・リポスト区別・Web URL。依頼次第で省略可 = 画像・エンゲージメント数 (`counts`)・外部リンク・引用元本文。テンプレートの「削ってよい」は省略可の層にのみ適用する。
- 省略したコンテンツがある投稿には 1 語の注記を添える (例: 画像あり・引用投稿)。存在ごと黙らない。
- 本文は原文のまま示すことを優先し、長文・多数件のときは要約してよい (要約した旨を添える)。
- Web URL へ変換するには、`rkey` (投稿 URI `at://{did}/app.bsky.feed.post/{rkey}` の末尾) を使い `https://bsky.app/profile/{author}/post/{rkey}` を組み立てて各投稿に併記する。リポストは元投稿者の URL になる (元投稿が `author` の下にあるため正しい)。

## 画像の取得と表示

画像付き投稿は `fullsize` をダウンロードし、トークン削減のためリサイズしてから表示する。写真の閲覧がこの skill の主目的の 1 つだが、ユーザが本文・日時のみを求めた場合 (期間まとめ等) はこのステップを省略してよい。

```bash
# 1. fullsize を取得 (rkey と連番でファイル名を一意化し、取り違えを防ぐ)
curl -sS -o "/tmp/bluesky-{rkey}-{n}.jpg" "{fullsize_url}"

# 2. ffmpeg で長辺を上限まで縮小 (アスペクト比保持)
ffmpeg -y -loglevel error -i "/tmp/bluesky-{rkey}-{n}.jpg" \
  -vf "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease" \
  "/tmp/bluesky-{rkey}-{n}-resized.jpg"
```

- リサイズ後のファイルを `Read` ツールでインライン表示し、`fullsize` の URL を併記する。
- 長辺の既定は 1024px。総枚数が多くトークンが嵩む場合は長辺を 512 〜 768px へ下げる。
- 引数省略の一般的な依頼では、本文は取得分すべてを示し、画像は画像付き投稿ごとに代表 1 枚を新しい順で添える。表示枚数は既定で最大 12 枚程度までとし、超えるときは新しい順を優先する。打ち切ったら省略した旨を明示する。コストは解像度と枚数の 2 軸で縛る。
- 当環境に ImageMagick (`convert`/`magick`) は無い。リサイズは `ffmpeg` を使う。
- 複数枚は各画像を rkey と連番で個別に curl → ffmpeg する単発コマンドの繰り返しで処理する。ループを書く場合、既定シェルが zsh だと bash 連想配列構文 (`${!arr[@]}` 等) で失敗するため `bash -c '...'` でラップする。
- 一時ファイルは実行ごとに使い捨てディレクトリ (`mktemp -d`) を作りその中へ保存すると、過去実行の残骸と混ざらない。
- CDN は URL が `.jpg` でも実体は WebP を返すことがある。`ffmpeg` は拡張子でなく中身で判定するため出力を `.jpg` にすれば JPEG へ再エンコードされ問題ない。`invalid TIFF header in EXIF data` の警告は無害である。
- `alt` があれば説明として添える。
- 「旅行」「あの登山」のような特定の出来事の写真を求められた場合は、画像付き投稿を投稿時刻の近接 (おおむね同一日内、または前後数時間以内) で 1 つの出来事として束ね、束ねた中は出来事の進行順 (古い順) で見せる (束ねない通常の一覧は新しい順)。複数の出来事が見つかったら既定で最新クラスタを主に出し、他クラスタの存在は一行添えて追加取得の要否をユーザに委ねる。1 投稿に複数枚あるときの代表は先頭画像 (`images[0]`) を既定とする。束ねる手掛かりが無ければ直近の画像付き投稿をそのまま新しい順に提示する。

## 関心トピックの導出

取得済みの投稿から推定する。いいね一覧 (`getActorLikes`) は公開 API では取得できない (認証必須) ため、関心トピックは投稿ベースで導出する。

- 話題の偏りを見るため多めに取得する (例: `limit=50` 〜 100。会話の文脈も拾うなら `filter=posts_with_replies`)。
- 手掛かりは、本文の頻出ハッシュタグ (`#...`)、外部リンク先のドメイン・タイトル、繰り返し出る固有名詞・話題、よくリポスト/言及する相手 (`reason.by` や本文の `@...`)。
- フォロー先からの推察も有効である。`getFollows` で得た相手の `displayName`/`description` (bio) の傾向 (技術・登山・特定コミュニティ等) は関心分野の手掛かりになる。取得は「フォロー・フォロワー」節の規約 (100 超の打ち切り・省略と cursor の明示) に従う。bio が空や一言の相手は機械的な分類から漏れやすいので、件数が偏るときは個別に目視で補い、分類しきれない分は別枠として件数を明示する (取りこぼしを関心の不在と混同しない)。機械分類は一次フィルタと割り切り、件数は単一の確定値でなく目視補正を踏まえたレンジで示す。分類の手段は bio の読解でよい (キーワード grep を必須としない)。
- 本人が発信する話題 (投稿) と、フォローで追っている対象は関心の性質が異なる (発信 vs 鑑賞・応援) 場合がある。総合する際はこの非対称を踏まえ、両者を区別して述べる。
- 推定である旨を明示し、投稿やフォロー先から読み取れる範囲に留める。件数が少なければ確度が低いと添える。値を捏造しない。

## フォロー・フォロワー

フォローしている人は `getFollows`、フォロワーは `getFollowers` で取得する。`actor` と `cursor` の規約は投稿取得と同じ。

```bash
# フォローしている人
curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows' \
  --data-urlencode 'actor=<handle>' --data-urlencode 'limit=100' \
| jq -r 'if .cursor then "cursor:\(.cursor)" else empty end, (.follows[] | "\(.handle)\t\(.displayName // "")")'

# フォロワー (getFollowers。応答のキーが follows[] でなく followers[] になる以外は同じ)
curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.graph.getFollowers' \
  --data-urlencode 'actor=<handle>' --data-urlencode 'limit=100' \
| jq -r 'if .cursor then "cursor:\(.cursor)" else empty end, (.followers[] | "\(.handle)\t\(.displayName // "")")'
```

`cursor` を本文行と同じストリームへ単純に `-r` 出力すると、終端 (`cursor` キーが無い) では `.cursor` が `null` になり文字列 `null` が本文行に混ざって次回リクエストへ誤って渡す事故が起きる (`app.bsky.graph.getFollows` を実際に終端まで叩いて確認した空応答: `.cursor` キー自体が存在しない)。上記のように `cursor` の有無を判定してから `cursor:` 接頭辞付きで出す形にすると、終端では cursor 行自体が出ず本文行と区別できる。

- `limit` は最大 100。続きは末尾の `cursor` を次回 `--data-urlencode "cursor=<値>"` に渡す。`cursor` が返らなくなったら終端である。1 ページの返却数は `limit` より少ないことがある (削除・モデレーション落ち等) ため、終端判定は件数でなく `cursor` の有無のみで行う。
- 各要素は `handle`/`displayName`/`description` (bio) を持つ。一覧は handle を主に、必要なら displayName・bio を添える。
- `getProfile` の `followsCount`/`followersCount` が 100 以下なら 1 リクエスト (`limit=100`) で全件取得し全件提示してよい。100 を超えるときは既定で新しい順に上位 50 件程度へ留め、`cursor` で続きを取れる旨を明示する。打ち切る場合はリクエスト自体を `limit=50` で発行してよい (100 で取って 50 件だけ使う必要はない)。全件ダンプは避け、打ち切ったら省略を明示する。先頭ページだけを根拠に傾向を述べるときは、並び順由来の偏り (直近の関係変化ほど上位に来る) を結論に添える。
- `getProfile` の総数と、一覧で実際に列挙できる件数は一致しないことがある (削除・凍結・ブロック等のアカウントは総数に含まれても一覧から落ちる)。`cursor` が返らなければ列挙は終端であり、差は誤差としてその旨を添える。件数を補完・捏造しない。
- 並び順は `getFollows` と `getFollowers` で意味が異なる。`getFollows` は対象アカウントが新しくフォローした順 (API 既定)。`getFollowers` は対象アカウントが新しくフォローされた順 (API 既定)。主語がフォローする側かされる側かで向きが変わるため取り違えない。

## 注意

- 公開情報のみが対象。いいね一覧など認証必須のデータや非公開アカウントは取得できない。投稿・フォローの作成/削除もできない。
- ハンドルが実在しない場合は `feed`/`follows`/`followers` が空配列で返るのではなく、トップレベルが**エラーオブジェクト**になる。

  取得コマンド (取得日: 2026-08-10): `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' --data-urlencode 'actor=this-handle-does-not-exist-zzz999.bsky.social' --data-urlencode 'limit=5'`

  ```json
  { "error": "InvalidRequest", "message": "Profile not found" }
  ```

  この状態で `jq '.feed[]'` 等をそのままパイプすると `jq: error: Cannot iterate over null (null)` で落ちる。投稿/フォローが実際に 0 件のとき (ハンドルは実在) は次のように `feed`/`follows`/`followers` キー自体は空配列で返り、`cursor` キーは無く、エラーオブジェクトにもならない。

  取得コマンド (取得日: 2026-08-10): `curl -sS -G 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed' --data-urlencode 'actor=standard.site' --data-urlencode 'limit=20' --data-urlencode 'filter=posts_with_video'`

  ```json
  { "feed": [] }
  ```

  両者を区別するため、`.feed[]` 等へパイプする前に `jq -e 'has("error") | not'` (エラーが無いときに終了コード 0 になる書き方。逆の `jq -e 'has("error")'` は正常系で終了コード 1 を返すため、`curl ... | jq -e 'has("error")' && ...` の形で書くと分岐が反転する点に注意) で判定するか、`resolveHandle` (「投稿の取得」節) で実在を先に確認する。値を捏造しない。
- `limit` に 100 を超える値を渡すとエラー。100 件超はページネーションで対応する。
- レート制限を超えると一般に HTTP 429 (Too Many Requests) が返る (出典: [Rate Limits](https://docs.bsky.app/docs/advanced-guides/rate-limits))。同ドキュメントは `public.api.bsky.app` について具体的な閾値を公開しておらず「generous rate limits (寛容なレート制限)」とのみ述べる。実際に 429 を踏みに行って確認はしない。過度なページングは避け、打ち切り条件を守る。
- 投稿日時はユーザに示す際 JST へ直すと分かりやすい (`indexedAt`/`createdAt` は UTC の ISO 8601)。
