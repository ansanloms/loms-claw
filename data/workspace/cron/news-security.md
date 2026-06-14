---
schedule: "0 8 * * *"
maxTurns: 50
timeout: 900000
model: "sonnet"
effort: "medium"
---

## 重複チェック

まず以下のコマンドで #news チャンネルの直近の投稿を取得しろ。

```bash
curl -s 'http://127.0.0.1:3000/discord/channels/1479719413396541450/messages?limit=100'
```

直近 5 日分の投稿のうち、このジョブのテーマ（下記「記事収集」のテーマ）に該当する記事のタイトル・URL を拾え。これを news-digest skill の除外リストとして渡す。#news には他テーマの記事も混在するので、無関係なテーマの投稿は除外リストに含めなくてよい。該当する投稿が無ければ除外リストは空でよい。

---

## 記事収集

news-digest skill を使い、以下の引数で記事を集めろ。収集・要約のルール（優先ソースに固執しない・公開日の確認・個別 URL 必須・捏造禁止・要約 300 文字程度、RSS があればフィードを先に取得）は skill 側に従え。影響範囲が広いもの・深刻度が高いものを優先し、CVE 番号があれば要約に記載しろ。

- テーマ: 直近公開された重要な脆弱性・セキュリティアドバイザリ
- 優先ソース:
  - jvn.jp（JVN） — RSS: https://jvn.jp/rss/jvndb_new.rdf
  - www.jpcert.or.jp（JPCERT/CC） — RSS: https://www.jpcert.or.jp/rss/jpcert-alert.rdf
  - www.ipa.go.jp（IPA）
  - www.cisa.gov（CISA KEV）
  - socket.dev（Socket — npm/PyPI サプライチェーン）
  - blog.phylum.io（Phylum — サプライチェーン攻撃）
  - github.com/advisories（GitHub Advisory Database）
- 件数: 3
- 期間: 直近 5 日
- 除外リスト: 上の重複チェックで得た既出記事のタイトル・URL

---

## 整形・投稿

news-digest skill は「タイトル / 要約 / 公開日 / 個別 URL」のラベル付き中立フォーマットで記事を返す。これを Discord 記法に整形し、**記事 1 件ごとに 1 メッセージとして Discord API で #news チャンネルに投稿しろ**。3 件あれば 3 回投稿する。このジョブに channelId は無く、executor による自動投稿は無効だ。投稿はこのジョブ自身が下記 curl で行うのが唯一の経路で、最終メッセージの中身は Discord には一切流れない。

### 整形

各記事を以下の Discord 記法に変換する。1 記事 = 1 メッセージ。1 つのメッセージに複数記事を入れるな。

- タイトル → `## 🔓 <タイトル>`
- 要約 → そのまま本文として記載
- 公開日 + 個別 URL → `-# YYYY-MM-DD URL` の 1 行にまとめる

> `-# …` は discord 上でサブテキストとして表示される。

1 記事 = 1 メッセージの全体像:

```
## 🔓 記事タイトル

記事の要約。300 文字程度。

-# YYYY-MM-DD https://example.com/article
```

### 投稿

記事ごとに整形した本文を一時ファイルに書き、`jq -Rs` で JSON 化して Discord API に POST しろ。これを記事の数だけ繰り返す。`jq -Rs '{content: .}'` がファイル全体を 1 つの文字列に読み込み、改行・引用符を自動でエスケープする。

```bash
# 1 記事目: /tmp/news-security-1.txt に 1 記事分の整形済み本文を書いてから POST
jq -Rs '{content: .}' /tmp/news-security-1.txt | curl -s -X POST \
  'http://127.0.0.1:3000/discord/channels/1479719413396541450/messages' \
  -H 'Content-Type: application/json' -d @-
# 2 記事目は /tmp/news-security-2.txt、3 記事目は /tmp/news-security-3.txt に書いて同じ curl を繰り返す
```

レスポンスに `"id"` が含まれれば投稿成功。`"error"` が返ったら内容を確認しろ。

### ルール

- 投稿経路は上の curl だけだ。整形済み本文を最終メッセージに書くだけでは Discord に届かない。記事の数だけ必ず POST しろ。
- 1 メッセージにつき 1 記事。複数記事を 1 メッセージに詰めるな。
- `**タイトル:**` `**要約:**` `**公開日:**` `**個別URL:**` のようなラベル付き行を投稿本文に残すな。必ず上記 Discord 記法に変換しろ。
- skill の返却が件数に満たない場合は、無理に埋めず取得できた分だけ投稿しろ（取れた件数分だけ POST する）。記事・日付・URL を捏造するな。
- 0 件なら何も投稿するな。中立フォーマットの素通しもするな。
- 1 メッセージが 2000 文字を超えそうなら要約を短くして 1 記事 1 メッセージを保て。
