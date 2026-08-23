# loms-claw

Discord + Claude Agent SDK のパーソナル AI エージェント。

## 利用規約

規約上の根拠・引用・経緯は [docs/terms-of-service.md](docs/terms-of-service.md) にまとめている。実装時に守る不変条件は次の 2 点。

- `bot/guard.ts` の `isAuthorized()` による単一ギルド ID・単一ユーザー ID（サブスクリプション購入者本人）との完全一致要求を崩さない。他のユーザーがアクセスできない状態を維持する。
- cron による自動実行の頻度・規模を「個人の通常利用（ordinary, individual usage）」の範囲に保つ。

## 技術スタック

- Deno
- discord.js v14
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` の `query()`)

## コミット規約

- [Conventional Commits](https://www.conventionalcommits.org/) に準拠する
- コミットメッセージは日本語で記述する
- 例: `feat: Discord ボタンによるツール承認機能を追加`、`fix: セッション ID のパースを修正`

## 開発コマンド

```bash
deno task start   # 起動
deno task dev     # ウォッチモードで起動
deno task test    # テスト + カバレッジ
deno task check   # 型チェック
deno task lint    # lint + format チェック
deno task fix     # lint 自動修正 + format
```

## Docker

`Dockerfile` / `compose.yaml` はリポジトリルートに置く。コマンドは全てリポジトリルートで実行する。

```bash
# ビルド
docker compose build

# 初回認証（コンテナ内で claude auth login を実行）
docker compose run --rm -it bot bash
# コンテナ内で: claude auth login → exit

# 本番起動
docker compose up -d

# 本番停止
docker compose down

# ログ確認
docker compose logs -f
```

コンテナ内の `claude` コマンドは Agent SDK が同梱する Claude Code バイナリへの symlink（ビルド時に作成）。
Claude Code CLI を別途インストールはしない。実行時の `query()` も同じ同梱バイナリを SDK が自動解決して使う。

### データディレクトリ

実行時データは host の `data/` に集約し、丸ごとコンテナの `/data` へ bind mount する（マウントはこの 1 つだけ）。
場所を変えたい場合は `compose.override.yaml` を使う。

| パス（host / コンテナ共通） | 用途                                     |
| --------------------------- | ---------------------------------------- |
| `data/home`                 | Claude の設定・認証情報の永続化          |
| `data/workspace`            | ワークスペース（.claude/, CLAUDE.md 等） |
| `data/config.json`          | アプリ設定（要作成）                     |

### 開発（devcontainer）

開発は `.devcontainer/` の定義でコンテナ内で行う。本番と同じイメージ・compose 定義に、ソースツリーを `/app` へ重ねる bind mount を追加しただけの構成。

```bash
# エディタ / devcontainer CLI でコンテナを開き、ターミナルで:
deno task dev   # --watch 付き起動。/app のソース編集で自動再起動
```

注意点:

- 設定は本番と同じ `/data/config.json`（イメージの `ENV LOMS_CLAW_CONFIG`）を読む。
- `deno task` は deno.json のあるディレクトリ（`/app`）を cwd に実行されるため、開発時のエージェントワークスペースはソースリポジトリ自身になる（本番は `/data/workspace`）。
- 本番と同じ compose プロジェクト・サービスを使うため、devcontainer を起動すると本番の bot コンテナは置き換えられる（同一トークンの二重ログインは起きない）。開発を終えたら `docker compose up -d` で本番構成に戻す。

### 環境変数

コンテナ内の置き場所は Dockerfile の `ENV` で宣言する（denoland/deno イメージの `DENO_DIR` と同じ流儀）:

| 変数                | 値（イメージに焼き込み） | 消費者                                         |
| ------------------- | ------------------------ | ---------------------------------------------- |
| `CLAUDE_CONFIG_DIR` | `/data/home`             | Claude Code（既定の `~/.claude` を置き換える） |
| `LOMS_CLAW_CONFIG`  | `/data/config.json`      | `config.ts` の設定ファイル解決                 |

`TZ` のみ host の `.env` から compose 経由で渡す（既定 `Asia/Tokyo`）。

## ファイル構成

```
main.ts                エントリポイント。loadConfig → initLogger → DiscordBot → start。リトライ付き。
config.ts              config.json → Config 型。@cfworker/json-schema で検証、`claude.cwd` は実行時注入。`LOMS_CLAW_CONFIG` でパス変更可。
config.schema.json     JSON Schema 本体 (外出し)。`config.json` 側で `$schema` として参照すれば IDE 補完が効く。
config.schema.ts       config.schema.json を @cfworker/json-schema の Validator で検証しエラー整形。applyConfigDefaults() が schema の `default` を補完 (ajv の useDefaults 相当を自前実装)。
logger.ts              名前空間付き軽量ロガー。`initLogger({ level, bufferSize })` で設定。リングバッファで直近ログをメモリ保持。
errors.ts              getErrorMessage(): unknown なエラー値からメッセージを取り出す共通ユーティリティ。
bot/mod.ts             DiscordBot クラス。messageCreate ハンドラ、start/shutdown。
bot/commands.ts        スラッシュコマンド定義とハンドラ（/claw settings show|set|unset で model/effort/show_thinking/active/session を操作）。
bot/guard.ts           isAuthorized(): ギルド ID + ユーザー ID + bot 除外の認可チェック。resolveActive(): per-scope の active 上書き (KV) と config の activeChannelIds を解決する共通ロジック。shouldRespond(): resolveActive() の結果 + mention / スレッドによる反応判定。
bot/queue.ts           ScopeQueue: scope (localId) 単位でメッセージ処理を直列化するキュー。応答中の scope に届いた次のメッセージを現在のターン終了後に処理する (並行 query と session 競合の防止)。
bot/message.ts         splitMessage(): 2000 文字分割。keepTyping(): typing インジケーター維持。ProgressReporter: ツール進捗表示。
claude/mod.ts          askClaude(): Agent SDK の query() を呼び出し SDKMessage ストリームを逐次 yield。buildQueryOptions() / normalizeEffort()。テストは queryFn DI でモック。
claude/system-prompt.ts  SystemPromptStore: .claude/system-prompt/ 配下を起動時に読み込み、コンテキスト (chat/cron) とスコープ (channelId/threadId) に応じて結合。
claude/template.ts     replaceTemplateVariables(): システムプロンプトの {{key}} 置換。
store/mod.ts           Store: Deno KV (SQLite backend) によるスコープ単位の session_id / model / effort / showThinking / active 永続化。スコープは {channelId, threadId?} の組。model / effort / showThinking は thread → channel → グローバルデフォルト (config.json `claude.defaults`) の動的フォールバック (showThinking は最終的に false)。active は thread → channel のみで解決し、グローバルデフォルトを持たない (どちらにも無ければ undefined。呼び出し側で config の activeChannelIds によるリスト判定へフォールバックする)。session は thread と channel で独立。applyPatch() で複数キーの部分更新 (JSON Merge Patch 意味論) を atomic に適用する。
approval/manager.ts    ApprovalManager: Discord ボタンによるツール承認/拒否。createCanUseTool(): ApprovalResult を SDK の PermissionResult に変換する canUseTool コールバックを生成。AskUserQuestion は承認フローを通さず QuestionManager へ委譲する。
approval/question.ts   QuestionManager: AskUserQuestion の質問を Discord の select menu で提示し回答を収集。「Other (自由入力)」は Modal で受け付け、回答を updatedInput.answers として返す。
approval/settings.ts   isInAllowList() / addToSettingsAllowList(): .claude/settings.json の permissions.allow 読み書き。
api/server.ts              統合 HTTP サーバー。Hono アプリ作成、サブルート（cron / logs / settings）マウント、共通エラーハンドラ。承認は in-process のため HTTP では扱わない。Discord 操作は Claude が公式 REST API を直接叩くため提供しない。`startApiServer(port, settingsCtx, cronCtx?)` は settings ルートの依存関係コンテキストを cron と同じ流儀で受け取る。
api/routes/cron.ts         cron ルート（GET /cron, POST /cron/run, POST /cron/reload）。
api/routes/logs.ts         ログ取得ルート（GET /logs）。リングバッファからフィルタ付きで取得。
api/routes/settings.ts     settings ルート（GET /settings/default, GET/PATCH/DELETE /settings/:id）。`SettingsRouteContext { store, resolveParentId? }` を受け取り、resolveScope() ヘルパーで `{id}` がスレッドか通常チャンネルかを解決してから Store.applyPatch() / getScopeSettings() / clearScope() を呼ぶ。resolveParentId が未注入・throw 時はチャンネル単独スコープにフォールバックする。
api/validate.ts            docs/api の OpenAPI から生成した internal-schemas.ts を単一ソースに、@cfworker/json-schema でリクエストボディを構造検証（matchesSchema / schemaErrorOf）。
api/internal-schemas.ts    docs/api の component schema を as const で書き出した自動生成物（deno task generate）。サーバの型（json-schema-to-ts の FromSchema）と検証の単一ソース。
cron/types.ts          CronJobDef 型定義。
cron/match.ts          cron 式パーサー + マッチャー。Temporal API でローカルタイム評価。
cron/loader.ts         frontmatter パーサー + cron/ ディレクトリスキャン。
cron/scheduler.ts      CronScheduler: setInterval ベースのカスタムスケジューラ。
cron/executor.ts       CronExecutor: スケジューラ連携 + askClaude() → Discord 送信。
Dockerfile             Deno コンテナイメージ。Claude Code は Agent SDK 同梱バイナリを使用（CLI の個別インストール無し）。CLAUDE_CONFIG_DIR / LOMS_CLAW_CONFIG を ENV で宣言。
compose.yaml           本番サービス定義。./data をコンテナの /data に bind mount（マウントはこれ 1 つ）。
.devcontainer/         開発コンテナ定義。compose.yaml にソースの /app bind mount を重ねる。
data/                  実行時データ置き場。home（Claude 設定・認証情報）/ workspace（ワークスペース）/ config.json（アプリ設定、要作成）。
```

## システムプロンプト

`.claude/system-prompt/` 配下にコンテキスト別 / スコープ別のファイルを置く。
起動時にキャッシュされ、メッセージ毎にスコープに応じて結合される。

| ファイル         | 役割                                                           |
| ---------------- | -------------------------------------------------------------- |
| `DEFAULT.md`     | 常に含める                                                     |
| `CHAT.md`        | テキストチャット時に含める                                     |
| `CRON.md`        | cron ジョブ時に含める                                          |
| `{channelId}.md` | 特定チャンネル / スレッドで含める (詳細は下のフォールバック節) |

### スコープ別ファイルのフォールバック

スレッド内のメッセージでは **thread → channel** の動的フォールバックでファイルを 1 件だけ採用する。Store の `model/effort` 解決と同じ発想:

1. `{threadId}.md` があればそれを採用
2. 無ければ `{channelId}.md` (= 親チャンネルの設定) を採用
3. どちらも無ければスキップ

これによりスレッド内でも親チャンネル用のシステムプロンプトが自動的に効く。スレッド固有の指示を上書きしたい場合のみ `{threadId}.md` を置けばよい。

**重要: 上記は「置き換え」であって「積み上げ」ではない**。`{threadId}.md` が選ばれた時、`{channelId}.md` は読まれない。スレッドで親チャンネルの指示も併せて効かせたい場合は、`{threadId}.md` 内に親チャンネルの指示も改めて書く必要がある (Store の `model/effort` の挙動と一致)。

### テンプレート変数

ファイル内で `{{key}}` 形式のプレースホルダーを使用できる。`resolve()` 呼び出し時に実際の値で置換される。未定義のキーはそのまま残る。

| 変数                       | 説明                            |
| -------------------------- | ------------------------------- |
| `{{discord.guild.id}}`     | ギルド ID                       |
| `{{discord.guild.name}}`   | ギルド名                        |
| `{{discord.channel.id}}`   | 現在のチャンネル / スレッド ID  |
| `{{discord.channel.name}}` | 現在のチャンネル / スレッド名   |
| `{{discord.channel.type}}` | チャンネル種別（text / thread） |
| `{{discord.user.id}}`      | メッセージ送信者の ID           |
| `{{discord.user.name}}`    | メッセージ送信者の名前          |

注意: `{{discord.channel.id}}` / `{{discord.channel.name}}` は **発話があった場所** の ID / 名前を返す。スレッド内で発話されたメッセージでは thread の ID / 名前が入る (親チャンネルの値ではない)。`{channelId}.md` がスレッド内でフォールバック採用された場合も同様で、ファイル内の `{{discord.channel.id}}` はスレッド ID に展開される。Discord REST API で「親チャンネル」を操作したい場合は ID をハードコードするか、別途取得すること。

使用例（`.claude/system-prompt/DEFAULT.md`）:

```markdown
現在のチャンネル: {{discord.channel.name}}（ID: {{discord.channel.id}}）
Discord REST API でこのチャンネルを操作する場合は上記 ID を使うこと。
```

注意: 定期実行（cron）など、メッセージコンテキストがない呼び出しでは
`vars` を省略または部分的に渡す。未定義の変数はプレースホルダーのまま残るため、
定期実行用のプロンプト（`CRON.md`）ではチャンネル/ユーザー固有の変数を使わないこと。

## 定期実行（cron）

`cron/` 配下の Markdown ファイルで定期実行ジョブを定義する。
YAML フロントマターにメタデータ、本文にプロンプトを記述する。
ディレクトリが存在しなければ cron 機能は無効。

### ジョブファイル形式

`cron/{name}.md`:

```markdown
---
schedule: "0 9 * * *"
channelId: "1234567890123456789"
maxTurns: 5
timeout: 120000
---

今日のニュースを要約して。重要度の高いものから3件。
```

ジョブ名はファイル名（拡張子除く）から自動決定される。

| フィールド      | 必須 | 説明                                                     |
| --------------- | ---- | -------------------------------------------------------- |
| `schedule`      | yes  | cron 式（5フィールド、TZ 依存）                          |
| `channelId`     | no   | 指定時: 結果を自動投稿。省略時: 投稿しない               |
| `resumeSession` | no   | 前回セッション引き継ぎ（デフォルト: `false`）            |
| `maxTurns`      | no   | `config.json` の `claude.maxTurns` をオーバーライド      |
| `timeout`       | no   | `config.json` の `claude.timeout` をオーバーライド（ms） |
| `once`          | no   | `true` で1回実行後にファイル自動削除                     |

### 動作の仕組み

1. Bot 起動時（`ClientReady` 後）に `cron/` 配下の `.md` ファイルを読み込み
2. `CronScheduler`（60秒 interval）でスケジュールを評価
3. マッチ時に `askClaude()` を実行
4. `channelId` 指定時は結果テキストを executor がチャンネルに送信。省略時は投稿しない
5. セッション ID を `cron:{name}` キーで保存（実行間のコンテキスト維持）
6. 同一ジョブの並行実行は防止される（前回実行中ならスキップ）

### リロード

ジョブ定義の変更は `POST /cron/reload` API で反映する。
AI がファイルを編集した後に `curl -s -X POST http://127.0.0.1:3000/cron/reload` を実行する。

### 手動実行

`POST /cron/run` で登録済みジョブを即座に実行できる。

```bash
curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"job-name"}' http://127.0.0.1:3000/cron/run
```

### ジョブ一覧 API

`GET /cron` で登録済みジョブの一覧を取得できる。

```bash
curl -s http://127.0.0.1:3000/cron
```

### 1回限りのジョブ（once）

フロントマターに `once: true` を設定すると、スケジュールまたは手動で1回実行された後にジョブファイルが自動削除される。1回きりのリマインダー等に使う。

書き方の詳細は `.claude/skills/cron/SKILL.md` を参照。

### システムプロンプト

cron ジョブ用のシステムプロンプトは `.claude/system-prompt/CRON.md` に記述する。
テンプレート変数はギルドレベル（`{{discord.guild.id}}`, `{{discord.guild.name}}`）のみ利用可能。

## 処理フロー

### テキスト

1. `messageCreate` → `isAuthorized()` で認可チェック
2. `shouldRespond()` で反応判定（active channel / mention / 親が active channel のスレッド）。active channel の判定は `resolveActive()` に委譲しており、KV の per-scope 上書き（`/claw settings set active` 等）が config の `activeChannelIds` より優先される
3. `message.channel.isThread()` から `StoreScope { channelId, threadId? }` を抽出（thread の場合 `parentId` を `channelId`、`message.channelId` を `threadId` に入れる）
4. `ScopeQueue.enqueue(localId)` で以降の処理を **scope 単位で直列化**。応答中の scope に届いた次のメッセージは現在のターン終了後に処理される（Claude Code が応答生成中の入力をキューに積むのと同じ挙動）。待機に入ったメッセージには ⏳ リアクションを付け、自分のターン開始時に外す。これにより同一セッションへの並行 query と session 競合を防ぐ
5. `message.cleanContent` からプロンプト抽出（bot mention を除去）
6. `keepTyping()` で typing 開始
7. `askClaude()` で Agent SDK の query() を実行し、`tool_progress` イベントで進捗表示
8. Store から解決した `showThinking` が `true` のとき、`thinking_delta`（推論）を `>` 引用形式で投稿（メンション無し）。thinking が流れるかは model / effort 依存
9. `Store` にスコープ単位で session ID を保存（次回 `query()` の `options.resume` で継続。thread と channel の session は独立）
10. `splitMessage()` で応答を分割送信

### スコープと設定の解決

各メッセージは `StoreScope` 単位で `session / model / effort / showThinking` を持つ。

- **スレッド外** のメッセージ: `{ channelId }` スコープ
- **スレッド内** のメッセージ: `{ channelId: parentId, threadId }` スコープ
- **cron ジョブ**: `{ channelId: "cron:{name}" }` スコープ（thread 無し）

`model / effort / showThinking` の解決順は **thread → channel → グローバルデフォルト** の動的フォールバック。グローバルデフォルトは `config.json` の `claude.defaults`（`showThinking` は未設定時 false）。
スレッドで `/claw settings set model=...` を叩くと thread のみに保存され、親チャンネルの設定には影響しない。`showThinking` も同様に `/claw settings set show_thinking=...` で per-scope に上書きでき、`/claw settings unset show_thinking` でフォールバックへ戻せる。
逆にスレッドで未設定なら親チャンネルの設定が即時に反映される。

`session` は thread と channel で完全に独立する。スレッドを切ると新規セッションとして始まり、親チャンネル側のセッションは触らない。`/claw settings unset session` をスレッド内で実行するとスレッドのセッションのみ削除する。

`active`（mention 不要で全メッセージに反応するかどうか）も `model / effort / showThinking` と同様に thread → channel の順で解決するが、**グローバルデフォルトを持たない**点が異なる。フォールバック先はグローバルデフォルトではなく、config の `activeChannelIds` によるチャンネル ID リスト判定（スレッドの場合は親チャンネル ID も見る）。thread / channel どちらの KV にも上書きが無ければ `ScopeSettings.active` はフィールドごと省略される。`/claw settings set active:<true|false>` で per-scope に上書きでき、`false` を明示すると config で active なチャンネルでも mention 必須へ落とせる。`/claw settings unset active` で上書きを削除し、config の判定へ戻す。

`/claw settings set|unset`（Discord スラッシュコマンド）と内部 HTTP API の `PATCH /settings/{id}` は、どちらも `Store.applyPatch()` を通して同じ部分更新ロジックを共有する。

## Discord 操作

Discord の情報取得・操作は Claude が公式 REST API（`https://discord.com/api/v10`）を Bash + curl で直接叩く。
bot トークンは `discord` skill の curl が環境変数 `DISCORD_BOT_TOKEN`（`Authorization: Bot ${DISCORD_BOT_TOKEN}`）から取る。skill 側は config.json を直読みしないため、トークンは skill の外から供給する。`askClaude()`（`buildQueryOptions()`）が `config.discord.token` を `query()` の env に `DISCORD_BOT_TOKEN` として注入し、SDK 同梱バイナリが spawn する Bash/curl へ渡す。curl の発行手順は `discord` skill に集約し、システムプロンプト等はその skill を参照する。
サーバー（ギルド）ID・チャンネル ID はシステムプロンプトの「Discord コンテキスト」（テンプレート変数）から得る。
操作手順は `discord` skill（`.claude/skills/discord/SKILL.md`）に記載。

（以前は Bot プロセス内の HTTP サーバーが discord.js Client 経由の内部 REST API（`/discord/*`）を提供していたが、
bot トークンを直接扱う構成へ移行し、内部ラッパーを廃止した。）

### 前提条件

- Discord Developer Portal で **Server Members Intent**（Privileged Gateway Intent）を有効にすること。
  メンバー一覧 API に必要。

## 内部 HTTP API（cron / ログ / 設定）

Bot プロセス内で `127.0.0.1:{claude.apiPort}` に HTTP サーバーを起動し、cron 操作・ログ取得・スコープ設定の操作を同一ポートで提供する。
Claude からは Bash + curl で呼び出す（ツール承認は in-process のため HTTP では扱わない）。

| メソッド | パス                | 説明                       |
| -------- | ------------------- | -------------------------- |
| `GET`    | `/cron`             | cron ジョブ一覧            |
| `POST`   | `/cron/run`         | cron 手動実行              |
| `POST`   | `/cron/reload`      | cron リロード              |
| `GET`    | `/logs`             | ログ取得                   |
| `GET`    | `/settings/{id}`    | スコープ設定の取得         |
| `PATCH`  | `/settings/{id}`    | スコープ設定の部分更新     |
| `DELETE` | `/settings/{id}`    | スコープ設定の全削除       |
| `GET`    | `/settings/default` | グローバルデフォルトの取得 |

スコープへの書き込みは leaf id（`threadId ?? channelId`）単位で行われる。そのため `PATCH` / `DELETE` はスレッド ID をそのまま `{id}` に渡せばそのスレッドのスコープを操作できる。

読み取り時のスコープ解決（`{id}` がスレッドか通常チャンネルかの判定と、スレッドの場合の親チャンネルへのフォールバック）はサーバが行う。呼び出し側は対象の ID を渡すだけでよく、親子関係を意識する必要はない。

## ツール権限

- in-process `canUseTool` コールバック: ツール使用前に Discord にボタンを送信してユーザーが承認/拒否（デフォルト動作）。`createCanUseTool()` が `ApprovalManager.requestApproval()` を呼び、結果を SDK の `PermissionResult` に変換する。
- `.claude/settings.json` の `permissions.allow`: 事前に許可するツール（ボタン確認をスキップ）。`settingSources: ["user", "project"]` で読み込まれる。
- bypass モード: `permissionMode: "bypassPermissions"`（+ `allowDangerouslySkipPermissions`）で全ツール無条件許可（必要時のみ）。
- `AskUserQuestion`: Claude からの質問（選択式）。承認ではなく回答収集のツールで、`createCanUseTool()` が `QuestionManager` に委譲して select menu（+ Other 自由入力の Modal）で回答を集め、`updatedInput.answers` に載せて allow で返す。キャンセル・タイムアウト（5 分）は deny となり、モデルは回答なしで続行する。**`permissions.allow` に `AskUserQuestion` を入れないこと**（SDK が `canUseTool` を呼ばず素通しし、回答が空のまま解決されるため）。

## 設定ファイル

設定は `data/config.json` に一元化されている。`data/config.json.example` をコピーして必須項目を埋める。

```bash
cp data/config.json.example data/config.json
# エディタで discordToken / guildId / authorizedUserId を入力
```

| 必須フィールド    | 内容                            |
| ----------------- | ------------------------------- |
| `discord.token`   | Discord bot トークン            |
| `discord.guildId` | 対象ギルド ID                   |
| `discord.userId`  | 操作を許可する唯一のユーザー ID |

その他のフィールドは省略可。`config.schema.ts` の `applyConfigDefaults()` が schema (`config.schema.json`) の `default` を補完する (@cfworker は副作用を持たないため ajv の `useDefaults: true` 相当を自前実装)。未知プロパティは `additionalProperties: false` で拒否されるため typo で気付く。

`config.json` の先頭に `"$schema": "../config.schema.json"` を書くと VS Code 等の IDE が補完・検証に使う (`data/config.json.example` にも入っている)。

### パス指定

デフォルトは `./data/config.json`。別パスを読ませる場合は環境変数 `LOMS_CLAW_CONFIG` で上書きする。

```bash
LOMS_CLAW_CONFIG=/path/to/config.json deno task start
```

### `.env` の役割

`.env` は docker compose が **host 側で** 参照する変数（現状 `TZ` のみ）を持つ。アプリ自体は `.env` を読まない。`.env.example` 参照。

`LOMS_CLAW_CONFIG` はアプリが読む **コンテナ / プロセス側の env**。Docker ではイメージの `ENV` が `/data/config.json` を指す。ローカル実行で別パスを使う場合はシェルから直接渡す。

### Docker 運用

`data/` ごと `/data` にマウントされるため、`data/config.json` がそのまま `/data/config.json` として見える。

```bash
cp data/config.json.example data/config.json
# 編集
docker compose up -d
```

## テスト方針

- 純粋関数（`isAuthorized`, `shouldRespond`, `splitMessage`, `buildQueryOptions`, `normalizeEffort` 等）は単体テストでカバー
- `askClaude()` は `queryFn` の DI でモック（`AsyncGenerator<SDKMessage>` を返す）を注入してテスト
- discord.js 依存コード（`bot/mod.ts`, `approval/manager.ts`）はモック化コストが高いため、ロジックを外部関数に抽出してテストする方針
- 実際の `query()` 実行（SDK 同梱 CLI の spawn）はインテグレーションテスト領域
- テスト実行: `deno task test`（カバレッジレポート付き）

### テスト命名規約

- テスト名は日本語で記述する
- `Deno.test` の名前はモジュール名や関数名（英語のまま）
- `t.step` の名前は「…こと」「…であること」の形式で記述する

```typescript
Deno.test("isAuthorized", async (t) => {
  await t.step("正しいギルド・ユーザーで許可されること", () => { ... });
  await t.step("bot ユーザーは拒否されること", () => { ... });
});
```

## 今後の課題

### 機能

- [ ] スレッド自動作成: active channel でのメッセージをスレッドに分離

### テスト・品質

- [ ] `bot/mod.ts` のテスト: DiscordBot クラスの統合テスト
- [ ] `approval/manager.ts` のテスト: ボタンインタラクションのテスト
- [ ] `api/server.ts` のテスト: 統合 HTTP サーバーのテスト

### インフラ

- [ ] CI/CD: GitHub Actions でテスト・lint・型チェックを自動実行
- [ ] Docker イメージのマルチステージビルド: 本番用イメージサイズの削減
- [ ] ヘルスチェック: Docker の healthcheck でプロセス生存確認
