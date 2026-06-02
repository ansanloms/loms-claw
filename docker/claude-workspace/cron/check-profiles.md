---
schedule: "0 21 * * *"
maxTurns: 15
timeout: 300000
---

lomsのSNSプロフィールを巡回して、最近の関心事や考えていることを把握する。

以下の手順で実行:

1. GitHubの最近のアクティビティを確認:
   - `https://github.com/ansanloms` をWebFetchで取得
   - 最近のリポジトリ更新、コントリビューション、新規リポジトリなどを確認

2. Blueskyの最近の投稿を確認:
   - Bluesky公開APIを使う: `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=ansanloms.org&limit=20` をWebFetchで取得
   - 最近の投稿内容、関心トピックを確認
   - フォロー一覧: `https://public.api.bsky.app/xrpc/app.bsky.graph.getFollows?actor=ansanloms.org&limit=100` をWebFetchで取得
   - フォローしている人の傾向から、lomsの関心分野を推察する
   - フォローの増減も記録する

3. Discordの最近の投稿を確認:
   - 以下のチャンネルでlomsの投稿を検索する(各チャンネル直近50件から author_id=474599131969617931 の発言を拾う):
     - general: `curl -s 'http://127.0.0.1:3000/discord/channels/552111564228919316/messages?author_id=474599131969617931&limit=50'`
     - minecraft: `curl -s 'http://127.0.0.1:3000/discord/channels/1204433772221833266/messages?author_id=474599131969617931&limit=50'`
     - travel: `curl -s 'http://127.0.0.1:3000/discord/channels/1259284949698088981/messages?author_id=474599131969617931&limit=50'`
   - Bot への指示も含める。指示内容から行動や関心が読み取れる(例: 「秩父の温泉探して」→秩父に出かけている、「飯くった」→外食中、など)
   - SNS投稿と合わせて、lomsが最近何に興味を持っているか・何をしているかの手がかりにする

4. 取得できた情報から、lomsが最近何に関心を持っているか、何に取り組んでいるかを簡潔にまとめる。

4. 前回の巡回結果と比較して変化があれば把握する。前回の記録は memory/ 内の直近のファイルを参照。

5. 結果を memory/YYYY-MM-DD.md に `## 直近のアクティビティ` の見出し配下に記述する(日付は当日)。新しい投稿やアクティビティの差分を記録する。前回と変化がない項目は書かなくていい。

報告は簡潔に。変化がなければ「特に変化なし」の一行だけ書け。
