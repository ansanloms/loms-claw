---
name: cron
description: cron/ ディレクトリの定期実行ジョブファイルの書き方。cron ジョブの作成・編集・削除時に参照する。
user-invocable: false
---

# Cron タスクファイルの書き方

`cron/` ディレクトリに `.md` ファイルを配置し、reload API を叩くと定期実行ジョブとして登録される。

## 重要

cron ジョブの管理はファイル操作で行う。`RemoteTrigger`、`CronCreate`、`CronDelete`、`CronList` などのツールは **このプロジェクトの cron とは無関係** なので使うな。

- ジョブ追加: `cron/{name}.md` ファイルを作成し、reload API を叩く
- ジョブ編集: 該当ファイルを編集し、reload API を叩く
- ジョブ削除: 該当ファイルを削除し、reload API を叩く
- ジョブ一覧: `curl -s http://127.0.0.1:3000/cron` または `ls cron/`
- 手動実行: `curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"ジョブ名"}' http://127.0.0.1:3000/cron/run`

**ファイルを変更したら必ず reload API を叩くこと。** reload しないと変更が反映されない。

```bash
curl -s -X POST http://127.0.0.1:3000/cron/reload
```

## フォーマット

YAML フロントマターとマークダウン本文で構成する。ジョブ名はファイル名（拡張子除く）から自動決定される。

```markdown
---
schedule: "0 9 * * *"
channelId: "1234567890123456789"
resumeSession: false
maxTurns: 5
timeout: 120000
model: sonnet
effort: medium
---

ここにプロンプトを書く。
```

## フロントマターのフィールド

| フィールド      | 必須 | 型      | デフォルト | 説明                                              |
| --------------- | ---- | ------- | ---------- | ------------------------------------------------- |
| `schedule`      | yes  | string  | —          | cron 式（5フィールド、TZ 環境変数依存）           |
| `channelId`     | no   | string  | —          | 結果の自動投稿先と承認ボタン送信先のチャンネル ID |
| `resumeSession` | no   | boolean | `false`    | 前回のセッションを引き継ぐか                     |
| `maxTurns`      | no   | number  | 10         | Claude の最大ターン数                             |
| `timeout`       | no   | number  | 300000     | タイムアウト（ミリ秒）                            |
| `once`          | no   | boolean | `false`    | `true` で1回実行後にファイル自動削除             |
| `model`         | no   | string  | —          | モデル alias または full name（後述）            |
| `effort`        | no   | string  | —          | effort level（後述）                              |

### channelId について

`channelId` の有無で結果の投稿方法が変わる。

- **指定あり**: Claude のテキスト出力が自動的にそのチャンネルに投稿される。ツール承認ボタンもこのチャンネルに送信される。プロンプト内で REST API（curl）を使ってメッセージ送信する必要はない。投稿したい内容をそのままテキスト出力として書けばいい。
- **省略**: テキスト出力は投稿されない。投稿が不要なジョブや、プロンプトの指示で Claude が REST API を使って投稿するジョブで使う。

### resumeSession について

- `false`（デフォルト）: 毎回新規セッションで実行する。前回の会話コンテキストは引き継がない。
- `true`: 前回のセッション ID を `--resume` で渡し、会話を継続する。コンテキストが蓄積し続ける点に注意。プロセス再起動でセッションはリセットされる。

### once について

- `true` に設定すると、スケジュールまたは手動実行で1回実行された後にジョブファイルが自動削除される。
- 1回きりのリマインダーや通知に使う。
- 成功・失敗を問わず実行後に削除される。

例:

```markdown
---
schedule: "0 15 * * *"
channelId: "1234567890123456789"
once: true
---

15時のリマインダー: 会議の準備をしろ。
```

### model / effort について

ジョブごとに使用モデルと推論コスト（effort）を上書きできる。

- `model`: `opus` / `sonnet` / `haiku` の alias、または `claude-sonnet-4-6` 等の full name。
- `effort`: `low` / `medium` / `high` / `xhigh` / `max` のいずれか。

#### 解決順序

`frontmatter > channel 設定 > グローバルデフォルト` の順で解決される。

1. ジョブの frontmatter に書かれていればそれを使う。
2. 無ければ `channelId` で指定したチャンネルの `/claw status set` で設定された値を使う（`channelId` 省略時はスキップ）。
3. それも無ければ `config.json` の `claude.defaults.model` / `claude.defaults.effort` を使う。
4. いずれも未設定なら CLI のデフォルトに任せる（`--model` / `--effort` を渡さない）。

#### 使い分け

- **重い分析・要約等で精度が要るジョブ**: `model: opus` + `effort: high` 以上。
- **軽量な定型通知・リマインダー**: `model: haiku` + `effort: low` でコストとレイテンシを抑える。
- **チャンネルの既定値を使いたい**: 両方とも省略する（`channelId` 経由で `/claw status` の設定が拾われる）。

例:

```markdown
---
schedule: "0 9 * * *"
channelId: "1234567890123456789"
model: opus
effort: high
---

ニュース要約: 直近24時間の重要記事を5件まとめろ。
```

## cron 式の書き方

5フィールド: `分 時 日 月 曜日`（TZ 環境変数依存）

- `*` 任意の値
- `*/N` N ごと（例: `*/15` → 0,15,30,45）
- `N-M` 範囲（例: `1-5` → 月〜金）
- `N,M,L` リスト
- 曜日: 0=日, 1=月, ..., 6=土, 7=日

例:

- `0 9 * * *` 毎日 09:00
- `0 9 * * 1-5` 平日 09:00
- `*/30 * * * *` 30分ごと
- `0 0 1 * *` 毎月1日 00:00

## 注意

- `schedule` は必ず引用符で囲むこと（YAML でパースエラーになる場合がある）
- プロンプト本文（フロントマター後の部分）が空の場合はエラーになる
- ファイルを追加・変更・削除したら必ず reload API を叩くこと
