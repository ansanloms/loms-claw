# bluesky

指定ユーザ (主に自分自身) の Bluesky の公開情報を、認証なしの公開 API から取得する skill。AT Protocol の公開 AppView (`public.api.bsky.app`) を利用する。

## できること

- 直近の投稿内容・関心トピックの把握 (`app.bsky.feed.getAuthorFeed`)
- プロフィールと各種件数の取得 (`app.bsky.actor.getProfile`)
- フォロー/フォロワーの一覧と、傾向からの関心分野の推測 (`app.bsky.graph.getFollows`/`getFollowers`)
- 画像はダウンロード後に ffmpeg でリサイズして表示

## 対象外

- いいね一覧など認証必須のデータの取得
- 投稿・フォローの作成/削除

対象は公開情報のみ。

## 発動する場面

「最近何を投稿したか」「旅行の写真を見たい」「誰をフォローしているか」「フォロワーは誰か」など、公開情報の把握を求められたとき。

## 導入

```sh
apm install ansanloms/skills/bluesky --target claude
```

詳細は [SKILL.md](./SKILL.md) を参照。
