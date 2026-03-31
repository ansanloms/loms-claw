# Cron タスクファイルの書き方

## ファイルの場所

`.claude/cron/` ディレクトリに `.md` ファイルを配置する。ファイル名は `{name}.md` とする。

## フォーマット

YAML フロントマターとマークダウン本文で構成する。

```markdown
---
name: job-name
description: ジョブの説明
schedule: "0 9 * * *"
channelId: "1234567890123456789"
maxTurns: 5
timeout: 120000
---

ここにプロンプトを書く。
```

## フロントマターのフィールド

| フィールド    | 必須 | 型     | 説明                                     |
| ------------- | ---- | ------ | ---------------------------------------- |
| `name`        | yes  | string | ジョブ名（一意、ファイル名と一致させる） |
| `description` | no   | string | 人間向け説明                             |
| `schedule`    | yes  | string | cron 式（5フィールド、UTC）              |
| `channelId`   | yes  | string | 結果送信先の Discord チャンネル ID       |
| `maxTurns`    | no   | number | Claude の最大ターン数                    |
| `timeout`     | no   | number | タイムアウト（ミリ秒）                   |

## cron 式の書き方

5フィールド: `分 時 日 月 曜日`（UTC）

- `*` 任意の値
- `*/N` N ごと（例: `*/15` → 0,15,30,45）
- `N-M` 範囲（例: `1-5` → 月〜金）
- `N,M,L` リスト
- 曜日: 0=日, 1=月, ..., 6=土, 7=日

例:

- `0 9 * * *` 毎日 09:00 UTC
- `0 9 * * 1-5` 平日 09:00 UTC
- `*/30 * * * *` 30分ごと
- `0 0 1 * *` 毎月1日 00:00 UTC

## 注意

- `name` とファイル名（拡張子除く）は一致させること
- `schedule` は必ず引用符で囲むこと（YAML でパースエラーになる場合がある）
- プロンプト本文（フロントマター後の部分）が空の場合はエラーになる
- ファイルを追加・変更・削除すると自動的にリロードされる（再起動不要）

## API でのジョブ管理

curl で CRUD 操作が可能:

```bash
# 一覧
curl http://127.0.0.1:3000/cron/jobs

# 詳細
curl http://127.0.0.1:3000/cron/jobs/daily-summary

# 作成/更新
curl -X PUT http://127.0.0.1:3000/cron/jobs/daily-summary \
  -H "Content-Type: text/markdown" \
  --data-binary @.claude/cron/daily-summary.md

# 削除
curl -X DELETE http://127.0.0.1:3000/cron/jobs/daily-summary

# リロード
curl -X POST http://127.0.0.1:3000/cron/reload
```
