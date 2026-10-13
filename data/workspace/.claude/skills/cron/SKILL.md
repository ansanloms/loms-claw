---
name: cron
description: cron/ ディレクトリの定期実行ジョブファイル (prompt ジョブ `.md` / command ジョブ `.yaml`) の書き方と、内部 API による一覧・手動実行・reload の手順。cron ジョブの作成・編集・削除・一覧・手動実行時に参照する。
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
- 手動実行: `curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"ジョブ名"}' http://127.0.0.1:3000/cron/run`（`200` はジョブの成功を意味しない。後述「`POST /cron/run`」）

**ファイルを変更したら必ず reload API を叩くこと。** reload しないと変更が反映されない。

```bash
curl -s -X POST http://127.0.0.1:3000/cron/reload
```

### reload が `{"ok": true}` を返しても、ジョブが登録されたとは限らない

reload は不正なジョブファイル（YAML フロントマターの構文エラー、必須フィールド欠落、本文が空等）を**エラーを返さずに捨てる**。エラーは `cron-loader` 名前空間のログに ERROR で出るだけで、reload の HTTP レスポンスは例外の有無に関わらず常に `{"ok": true}` になる。`{"ok": true}` を見て「登録できた」と判断してはいけない。

ファイルを追加・変更したら、必ず次の手順で検証すること。

1. `POST /cron/reload` を叩く。
2. `GET /cron` の `jobs` に目的の `name` が含まれるか確認する。
3. 含まれていなければ `GET /logs?namespace=cron-loader&level=ERROR` で原因を確認する（詳細は `logs` skill 参照）。

フロントマターの構造エラー（未知のキー・型違い・必須欠落）があると、cron 式の構文チェックと `channelId` の引用符漏れチェックはその時点では行われない。ログに出たエラーを直しても、次の reload でこれらのエラーが新たに出ることがある。直したら再度 1〜3 を繰り返し、`GET /cron` に載るまで確認すること。

```bash
# 1. reload
curl -s -X POST http://127.0.0.1:3000/cron/reload

# 2. 登録確認（jobs はオブジェクトの配列。jq '.jobs[]' で見る）
curl -s http://127.0.0.1:3000/cron | jq '.jobs[] | select(.name == "news.md")'

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
      "name": "news.md",
      "kind": "prompt",
      "schedule": "0 9 * * *",
      "channelId": "1234567890123456789",
      "once": false
    },
    {
      "name": "reminder.md",
      "kind": "prompt",
      "schedule": "30 18 * * 5",
      "once": true
    },
    {
      "name": "check.yaml",
      "kind": "command",
      "schedule": "*/30 * * * *",
      "once": false
    }
  ]
}
```

#### cron 機能が無効な場合（503）

```json
{ "error": "cron not available" }
```

### `POST /cron/run`

ジョブの実行が終わるまで待ってから応答を返す（prompt ジョブなら Claude の応答完了まで。最長でジョブの `timeout` 程度かかる）。

`200` はジョブの成功を意味しない。ジョブ内の失敗（チャンネルが存在しない、Claude の実行エラー、command ジョブの非 0 終了、タイムアウト等）は内部で捕捉されてログに出るだけで、応答は `200` のままになる。同名ジョブが実行中で skip された場合も `200` になる。手動実行の結果は次で確認すること。

- `channelId` があるジョブ: 投稿先チャンネルに結果、または `[cron: {name}] ...` のエラー通知が届いているか。ただしチャンネルの取得自体に失敗した場合（存在しない ID 等）は通知されない。
- 共通: `GET /logs?namespace=cron&level=ERROR` に `cron job "{name}" failed: ...` が出ていないか。

#### 成功（200）

```json
{ "ok": true, "name": "news.md" }
```

#### ジョブが見つからない場合（404）

```json
{ "error": "job not found: news.md" }
```

#### リクエストボディが不正な場合（400、JSON 不正・`name` 未指定等）

JSON として読めない場合は `{ "error": "invalid JSON body" }`。`name` の欠落・空文字・余分なキー等はスキーマ検証のエラーメッセージが `error` に入る。

```json
{ "error": "invalid JSON body" }
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

YAML フロントマターとマークダウン本文で構成する。ジョブ名はファイル名そのもの（拡張子込み）から自動決定される。

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
| `maxTurns`      | no   | number  | ※          | Claude の最大ターン数                             |
| `timeout`       | no   | number  | ※          | タイムアウト（ミリ秒、0 より大きい数）            |
| `once`          | no   | boolean | `false`    | `true` で1回実行後にファイル自動削除              |
| `model`         | no   | string  | —          | モデル alias または full name（後述）             |
| `effort`        | no   | string  | —          | effort level（後述）                              |

※ 省略時は `config.json` の `claude.maxTurns`・`claude.timeout` を使う（config スキーマ上の既定は 10・300000 だが、実運用の `config.json` で上書きされうる）。

### channelId について

`channelId` は必ず引用符で囲んだ文字列で書くこと（例: `channelId: "1234567890123456789"`）。理由: 引用符なしの 19 桁の ID は YAML で数値として読まれて精度が落ちるため、`"channelId" must be quoted as a string` のエラーで読み込みが失敗する。

reload は `channelId` のチャンネルが実在するかを検証しない。存在しない ID でも `GET /cron` には登録され、実行時に失敗する（`cron` 名前空間の ERROR ログに出るだけで Discord への通知は無い）。ID が正しいかは、手動実行（ジョブが実際に 1 回動く）の後に投稿の有無とログで確かめるしかない（後述「`POST /cron/run`」）。

`channelId` の有無で結果の投稿方法が変わる。

- **指定あり**: Claude の最終応答のテキストが自動的にそのチャンネルに投稿される（最終応答が空文字なら何も投稿されない）。ツール承認ボタンもこのチャンネルに送信される。プロンプト内で REST API（curl）を使ってメッセージ送信する必要はない。投稿したい内容をそのままテキスト出力として書けばいい。
- **省略**: テキスト出力は投稿されない。投稿が不要なジョブや、プロンプトの指示で Claude が REST API を使って投稿するジョブで使う。承認ボタンの送信先も無いため、承認が必要なツール呼び出しは自動で拒否される。

### resumeSession について

- `false`（デフォルト）: 毎回新規セッションで実行する。前回の会話コンテキストは引き継がない。
- `true`: 前回のセッション ID を `--resume` で渡し、会話を継続する。コンテキストが蓄積し続ける点に注意。プロセス再起動でセッションはリセットされる。

### once について

**`once: true` は実行後にジョブファイルを自動削除する不可逆な操作。** ファイルを消してしまうので、内容を復元する手段は無い（他ジョブからコピーして作り直す以外に無い）。ユーザーから明示的な指示が無い限り、既存ジョブに `once: true` を勝手に付けたり、`once: true` の新規ジョブを作ったりする前に、削除される前提で問題ないかユーザーへ確認すること。

- `true` に設定すると、スケジュールまたは手動実行で 1 回実行された後、成功・失敗を問わずジョブファイルが削除される。
- ファイル削除後、bot が自動的に reload を行う。エージェントが手動で `POST /cron/reload` を叩く必要は無い。
- 1 回きりのリマインダーや通知に使う。

#### ファイル名の命名規則

`once: true` の一時ジョブは、ファイル名を `<name>.once.md` にすること（例: `reminder.once.md`）。実行後に自動削除される前提のファイルなので、リポジトリの git 追跡対象から外している（`.gitignore` の `data/workspace/cron/*.once.md`）。ジョブ名はファイル名そのもの（`cron/loader.ts` の `validateCronJob()`）なので、`<name>.once.md` のジョブ名も `<name>.once.md` になる。`GET /cron` や手動実行の `name` にもこの形（拡張子込み）で指定する。

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
3. それも無ければ `config.json` の `claude.defaults.model`・`claude.defaults.effort` を使う。
4. いずれも未設定なら CLI のデフォルトに任せる（`--model`・`--effort` を渡さない）。

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

### プロンプト本文とテンプレート変数

cron 実行ではチャンネル/ユーザー固有のテンプレート変数（`{{discord.channel.id}}`・`{{discord.channel.name}}`・`{{discord.channel.type}}`・`{{discord.user.id}}`・`{{discord.user.name}}`）は使えない。

- ジョブファイルの本文（プロンプト）はテンプレート変数を一切置換しない。`{{...}}` は文字列のまま Claude に渡る。
- cron 実行時に結合されるシステムプロンプト（`.claude/system-prompt/` の `DEFAULT.md`・`CRON.md`・`{channelId}.md`）で置換されるのは `{{discord.guild.id}}`・`{{discord.guild.name}}` だけ。チャンネル/ユーザー変数はプレースホルダーのまま残る。

ユーザーやチャンネルを指したい場合は ID を直書きする。チャンネルごとに文脈を変えたいなら、変数ではなくそのチャンネル用の `{channelId}.md` に固定文で書く。なお、システムプロンプトのファイルは bot 起動時にだけ読み込まれる。変更の反映には bot の再起動が要り、`POST /cron/reload` では反映されない。本人へのメンションはテキスト出力に `<@ユーザーID>` を書けば通知される。bot の allowedMentions により本人以外・bot 自身へのメンションは解決されないため、自動投稿で AI to AI 自己メンションは起こせない。チャンネルへの言及は `<#チャンネルID>` と書く。

## command ジョブ (`.yaml`)

ここまでの `.md` ファイルは Claude にプロンプトを渡す「prompt ジョブ」。判断が要らない定型処理（固定のチェック・通知等）は、Claude を介さず `sh -c` でコマンドを直接実行する「command ジョブ」（`cron/{name}.yaml`）で書ける方が軽い。

### フォーマット

YAML ファイル 1 つがそのままジョブ定義になる（フロントマター/本文の区別は無い）。

```yaml
schedule: "0 9 * * *"
command: "cron/scripts/check.sh"
channelId: "1234567890123456789"
```

### フィールド

| フィールド  | 必須 | 型      | デフォルト | 説明                                                                               |
| ----------- | ---- | ------- | ---------- | ---------------------------------------------------------------------------------- |
| `schedule`  | yes  | string  | —          | cron 式（prompt ジョブと同じ）                                                     |
| `command`   | yes  | string  | —          | `sh -c` に渡すコマンド文字列                                                       |
| `channelId` | no   | string  | —          | 結果の投稿先チャンネル ID                                                          |
| `timeout`   | no   | number  | ※          | タイムアウト（ミリ秒、0 より大きい数）。省略時は `config.json` の `claude.timeout` |
| `once`      | no   | boolean | `false`    | `true` で 1 回実行後にファイル自動削除                                             |

`maxTurns`/`resumeSession`/`model`/`effort` 等 prompt ジョブ専用のフィールドは command ジョブには無い（書くと `"maxTurns" is not an allowed property` 等のエラーになる）。

### 実行の仕組み

- `command` は `sh` (bash ではない) で実行される。bash の機能（配列・`[[ ]]` 等）が要るなら `command: "bash cron/scripts/check.sh"` のように明示的に `bash` を呼び出すこと。
- タイムアウト時、`signal` の SIGTERM は `sh` プロセスに送られるだけで、`sh` が起動した子プロセスは残りうる。長時間動く子プロセスを起動するスクリプトは、自前で `trap` 等の後始末をすること。
- 標準出力 (`stdout`) の有無で投稿を制御する。`stdout` が空でなく `channelId` が指定されていれば、その内容がそのまま（`splitMessage()` で 2000 文字ごとに分割されて）投稿される。`stdout` が空、または `channelId` 省略時は投稿されない。`stdout` (trim 後) が 4000 文字を超える場合は先頭 4000 文字に切り詰められ、末尾に `... (truncated, N chars)` の注記が付く（ログには全量が出る）。
- 終了コードが 0 以外なら失敗として扱われ、`channelId` があれば `[cron: {name}] ...` の形でエラー通知が投稿される（標準エラー出力 (`stderr`) の先頭行が通知に、全文がログに載る）。
- ストア (session/model/effort)・システムプロンプト・ツール承認は一切関与しない。

### ロジックの置き場所

`command` フィールドに複雑なシェルスクリプトを直接書かず、ロジックは `cron/scripts/{name}.sh` に置いて `command` からはそれを呼ぶだけにすること（例: `command: "cron/scripts/check.sh"`）。理由: YAML の 1 行に収める必要が無くなり、シェルスクリプトとして構文チェック・単体実行がしやすくなる。

### `.once.yaml` の命名規則

`once: true` の一時 command ジョブも、prompt ジョブの `.once.md` と同じ規則に従う。ファイル名を `<name>.once.yaml` にすること（例: `check.once.yaml`）。実行後に自動削除される前提のファイルなので、git 追跡対象から外している（`.gitignore` の `data/workspace/cron/*.once.yaml`）。ジョブ名はファイル名そのものなので、`<name>.once.yaml` のジョブ名も `<name>.once.yaml` になる。

## 読み込み対象

reload（と bot 起動時）に読み込まれるのは `cron/` 直下のファイルのうち、名前が `.md`（prompt ジョブ）または `.yaml`（command ジョブ）で終わるものだけ。

- `.yml` は対象外（command ジョブは必ず `.yaml` にする）。
- それ以外の拡張子のファイルと、`cron/` 配下のサブディレクトリ（`cron/scripts/` 等）の中身は読まれない。エラーログも出ない。

フロントマターに `enabled: false` 等を足してはいけない。そういうフィールドは存在せず、未知のキーは `"enabled" is not an allowed property` のエラーになる。結果的にジョブは読み込まれないが、reload のたびに ERROR ログを出す壊れたファイルになる。

## cron 式の書き方

5 フィールド: `分 時 日 月 曜日`（TZ 環境変数依存。compose の既定は `Asia/Tokyo`）

- `*` 任意の値
- `N` 単一の値
- `N-M` 範囲（例: `1-5` → 月〜金）
- `*/S` S ごと（例: `*/15` → 0,15,30,45）
- `N/S` N からそのフィールドの最大値まで S ごと（例: 時フィールドの `1/3` → 1,4,7,...,22）
- `N-M/S` N〜M の範囲で S ごと（例: `9-17/2` → 9,11,13,15,17）
- `A,B,C` リスト（各要素に上記の形を使える。例: `0,30`、`1-5,0`）
- 曜日: 0=日、1=月、...、6=土、7=日

日と曜日を両方指定した場合は、両方を満たす日だけに一致する（例: `0 9 1 * 1` は「1 日かつ月曜」の日だけ）。一般的な cron の「どちらかに一致」とは異なるので注意する。

使えないもの: `MON`・`JAN` 等の名前、`?`・`L`・`W`・`#`、秒や年のフィールド（6 フィールド以上）。範囲外の値（分の `60`、時の `24` 等）や `start > end` の範囲は構文エラーとして読み込みが失敗する。

`*/S` は各フィールドの範囲（分なら 0〜59）の中で S 刻みにするだけで、時をまたいで等間隔にはならない。たとえば分フィールドの `*/90` は「毎時 0 分」になる（エラーにはならない）。各フィールドは独立に評価されるため、60 分や 24 時間を割り切れない間隔（90 分ごと等）や、範囲の端だけ分が異なる指定（「9:00〜18:00 の毎時 0 分と 30 分」で 18:30 を含めない等）は 1 つの式では書けない。その場合は同じ内容のジョブを複数ファイルに分けるか（例: 90 分ごと = `0 */3 * * *` と `30 1/3 * * *` の 2 ファイル、9:00〜18:00 = `0,30 9-17 * * *` と `0 18 * * *` の 2 ファイル）、ユーザーに指定の変更を提案すること。分割した場合は、全ファイルが `GET /cron` に載っていることを確認する（片方だけだと間隔が崩れる）。

年は指定できないので、日付を指定した式（例: `30 18 14 10 *`）は毎年その日時に実行される。特定の日時に 1 回だけ実行したい場合は `once: true` と組み合わせる（前述「once について」）。

月末（`L`）のように cron 式で直接書けない日付は、候補日に起動して中で判定する。例: `0 21 28-31 * *` で起動し、「明日が 1 日でなければ何もせず終える」判定を command ジョブならスクリプト内（何も出力せず終了 0）、prompt ジョブなら本文の先頭（何も出力せず終了）に書く。prompt ジョブは候補日のたびに Claude が起動する点に注意する。

例を次に示す。

- `0 9 * * *` 毎日 09:00
- `0 9 * * 1-5` 平日 09:00
- `*/30 * * * *` 30 分ごと
- `0 0 1 * *` 毎月 1 日 00:00

## 注意

- `schedule` は必ず引用符で囲むこと。理由: YAML でパースエラーになる場合がある。
- フロントマター後のプロンプト本文が空の場合はエラーになる。`cron-loader` の ERROR ログに出て reload では捨てられる（上記「reload の検証手順」参照）。
- ファイルを追加・変更・削除したら必ず reload API を叩き、`GET /cron` で反映を確認すること（`once: true` によるファイル削除後は自動 reload されるため不要）
