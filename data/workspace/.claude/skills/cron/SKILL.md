---
name: cron
description: cron/ ディレクトリの定期実行ジョブファイルの書き方。cron ジョブの作成・編集・削除時に参照する。
user-invocable: false
---

# Cron タスクファイルの書き方

`cron/` ディレクトリに `.md` ファイルを配置し、reload API を叩くと定期実行ジョブとして登録される。`cron/` はワークスペースルート（bot プロセスの cwd）からの相対パス。エージェントの作業ディレクトリがワークスペースルートであることを前提にしている。

内部 API のポートは固定ではない。`config.json` の `claude.apiPort`（既定 3000）で変わる。次の例では `3000` を使う。

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

### reload が `{"ok": true}` を返しても、ジョブが登録されたとは限らない

reload は不正なジョブファイル（YAML フロントマターの構文エラー、必須フィールド欠落、本文が空等）を**黙って捨てる**。エラーは `cron-loader` 名前空間のログに ERROR で出るだけで、reload の HTTP レスポンスは例外の有無に関わらず常に `{"ok": true}` になる。`{"ok": true}` を見て「登録できた」と判断してはいけない。

ファイルを追加・変更したら、必ず次の手順で検証すること。

1. `POST /cron/reload` を叩く。
2. `GET /cron` の `jobs` に目的の `name` が含まれるか確認する。
3. 含まれていなければ `GET /logs?namespace=cron-loader&level=ERROR` で原因を確認する（詳細は `logs` skill 参照）。

```bash
# 1. reload
curl -s -X POST http://127.0.0.1:3000/cron/reload

# 2. 登録確認（jobs はオブジェクトの配列。jq '.jobs[]' で見る）
curl -s http://127.0.0.1:3000/cron | jq '.jobs[] | select(.name == "news")'

# 3. 見つからなければ原因調査
curl -s 'http://127.0.0.1:3000/logs?namespace=cron-loader&level=ERROR'
```

## エンドポイントのレスポンス形状

### `GET /cron`

**オブジェクト**を返す。トップレベルが配列ではないので `jq '.[]'` ではなく `jq '.jobs[]'` を使うこと。`channelId` は未指定のジョブでは省略される。

#### 成功（200）

```json
{
  "jobs": [
    {
      "name": "news",
      "schedule": "0 9 * * *",
      "channelId": "1234567890123456789",
      "once": false
    },
    { "name": "reminder", "schedule": "30 18 * * 5", "once": true }
  ]
}
```

#### cron 機能が無効な場合（503）

```json
{ "error": "cron not available" }
```

### `POST /cron/run`

#### 成功（200）

```json
{ "ok": true, "name": "news" }
```

#### ジョブが見つからない場合（404）

```json
{ "error": "job not found: news" }
```

#### リクエストボディが不正な場合（400、`name` 未指定等）

```json
{ "error": "..." }
```

#### cron 機能が無効な場合（503）

```json
{ "error": "cron not available" }
```

### `POST /cron/reload`

#### 成功（200）

```json
{ "ok": true }
```

#### reload 機能が無効な場合（503）

```json
{ "error": "cron reload not available" }
```

成功レスポンスがファイル読み込みの成否を保証しない点は前述のとおり。上記「reload が `{"ok": true}` を返しても、ジョブが登録されたとは限らない」の検証手順を必ず踏むこと。

## フォーマット

YAML フロントマターとマークダウン本文で構成する。ジョブ名はファイル名（拡張子除く）から自動決定される。

```markdown
---
schedule: "0 9 * * *"
channelId: "1234567890123456789"
resumeSession: false
maxTurns: 5
timeout: 120000
once: false
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
| `resumeSession` | no   | boolean | `false`    | 前回のセッションを引き継ぐか                      |
| `maxTurns`      | no   | number  | 10         | Claude の最大ターン数                             |
| `timeout`       | no   | number  | 300000     | タイムアウト（ミリ秒）                            |
| `once`          | no   | boolean | `false`    | `true` で1回実行後にファイル自動削除              |
| `model`         | no   | string  | —          | モデル alias または full name（後述）             |
| `effort`        | no   | string  | —          | effort level（後述）                              |

### channelId について

`channelId` の有無で結果の投稿方法が変わる。

- **指定あり**: Claude のテキスト出力が自動的にそのチャンネルに投稿される。ツール承認ボタンもこのチャンネルに送信される。プロンプト内で REST API（curl）を使ってメッセージ送信する必要はない。投稿したい内容をそのままテキスト出力として書けばいい。
- **省略**: テキスト出力は投稿されない。投稿が不要なジョブや、プロンプトの指示で Claude が REST API を使って投稿するジョブで使う。

### resumeSession について

- `false`（デフォルト）: 毎回新規セッションで実行する。前回の会話コンテキストは引き継がない。
- `true`: 前回のセッション ID を `--resume` で渡し、会話を継続する。コンテキストが蓄積し続ける点に注意。プロセス再起動でセッションはリセットされる。

### once について

**`once: true` は実行後にジョブファイルを自動削除する不可逆な操作。** ファイルを消してしまうので、内容を復元する手段は無い（他ジョブからコピーして作り直す以外に無い）。ユーザーから明示的な指示が無い限り、既存ジョブに `once: true` を勝手に付けたり、`once: true` の新規ジョブを作ったりする前に、削除される前提で問題ないかユーザーへ確認すること。

- `true` に設定すると、スケジュールまたは手動実行で 1 回実行された後、成功・失敗を問わずジョブファイルが削除される。
- ファイル削除後、bot が自動的に reload を行う。エージェントが手動で `POST /cron/reload` を叩く必要は無い。
- 1 回きりのリマインダーや通知に使う。

#### ファイル名の命名規則

`once: true` の一時ジョブは、ファイル名を `<name>.once.md` にすること（例: `reminder.once.md`）。実行後に自動削除される前提のファイルなので、リポジトリの git 追跡対象から外している（`.gitignore` の `data/workspace/cron/*.once.md`）。ジョブ名はファイル名から `.md` を除いたもの（`cron/loader.ts` の `validateCronJob()`）なので、`<name>.once.md` のジョブ名は `<name>.once` になる。`GET /cron` や手動実行の `name` にもこの形で指定する。

恒久ジョブ（`once` を付けない、または `once: false`）はこれまでどおり `<name>.md` で作り、git 追跡対象にする。

例を次に示す。

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

- `model`: `opus`/`sonnet`/`haiku` の alias、または `claude-sonnet-4-6` 等の full name。
- `effort`: `low`/`medium`/`high`/`xhigh`/`max` のいずれか。

#### 解決順序

`frontmatter > channel 設定 > グローバルデフォルト` の順で解決される。

1. ジョブの frontmatter に書かれていればそれを使う。
2. 無ければ `channelId` で指定したチャンネルの `/claw settings set` で設定された値を使う（`channelId` 省略時はスキップ）。
3. それも無ければ `config.json` の `claude.defaults.model`/`claude.defaults.effort` を使う。
4. いずれも未設定なら CLI のデフォルトに任せる（`--model`/`--effort` を渡さない）。

#### 使い分け

- **重い分析・要約等で精度が要るジョブ**: `model: opus` + `effort: high` 以上。
- **軽量な定型通知・リマインダー**: `model: haiku` + `effort: low` でコストとレイテンシを抑える。
- **チャンネルの既定値を使いたい**: 両方とも省略する（`channelId` 経由で `/claw settings` の設定が拾われる）。

例を次に示す。

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

5 フィールド: `分 時 日 月 曜日`（TZ 環境変数依存）

- `*` 任意の値
- `*/N` N ごと（例: `*/15` → 0,15,30,45）
- `N-M` 範囲（例: `1-5` → 月〜金）
- `N,M,L` リスト
- 曜日: 0=日、1=月、...、6=土、7=日

例を次に示す。

- `0 9 * * *` 毎日 09:00
- `0 9 * * 1-5` 平日 09:00
- `*/30 * * * *` 30 分ごと
- `0 0 1 * *` 毎月 1 日 00:00

## 注意

- `schedule` は必ず引用符で囲むこと（YAML でパースエラーになる場合がある）
- プロンプト本文（フロントマター後の部分）が空の場合はエラーになる（`cron-loader` の ERROR ログに出て reload では捨てられる。上記「reload の検証手順」参照）
- ファイルを追加・変更・削除したら必ず reload API を叩き、`GET /cron` で反映を確認すること（`once: true` によるファイル削除後は自動 reload されるため不要）
