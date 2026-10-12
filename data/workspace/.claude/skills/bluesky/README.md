# bluesky

指定ユーザ (主に自分自身) の Bluesky の公開情報を、認証なしの公開 API から取得する skill。AT Protocol の公開 AppView (`public.api.bsky.app`) を利用する。

## できること

直近の投稿内容と関心トピックは `app.bsky.feed.getAuthorFeed` で、プロフィールと各種件数は `app.bsky.actor.getProfile` で取得する。フォロー/フォロワーの一覧は `app.bsky.graph.getFollows`/`getFollowers` で取得し、その傾向から関心分野を推測する。画像はダウンロード後に ffmpeg でリサイズして表示する。

## 対象外

いいね一覧など認証必須のデータの取得と、投稿・フォローの作成/削除はできない。対象は公開情報のみ。

## 発動する場面

「最近何を投稿したか」「旅行の写真を見たい」「誰をフォローしているか」「フォロワーは誰か」など、公開情報の把握を求められたとき。

## 導入

```sh
apm install ansanloms/skills/bluesky --target claude
```

詳細は [SKILL.md](./SKILL.md) を参照。
