# loms-claw

Discord + Claude Code CLI (`claude -p`) のパーソナル AI エージェント。

## 利用規約に関する注意

本プロジェクトは Claude Code CLI の `-p` フラグ（ヘッドレスモード）を使用して Discord から Claude を呼び出す。

利用にあたっては以下の規約上の制約を理解しておく必要がある。

### OAuth トークンの利用制限

[Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) より:

> OAuth authentication is intended exclusively for Claude Code and Claude.ai.
> Using OAuth tokens obtained through Claude Free, Pro, or Max accounts in any other product,
> tool, or service — including the Agent SDK — is not permitted and constitutes a violation
> of the Consumer Terms of Service.

本プロジェクトは OAuth トークンを抽出・流用せず、`claude -p` コマンドを直接 spawn する構造のため、この制限には該当しない。

ただし Anthropic の解釈が変わる可能性があるため、定期的な確認を推奨する。

### アカウント共有の禁止

[Consumer Terms of Service](https://www.anthropic.com/legal/consumer-terms) より:

> You may not share your Account login information, Anthropic API key, or Account credentials with anyone else.

Discord の指定ギルド・指定ユーザー（1 人）のみが操作できる設計により、1 つのサブスクリプションを複数人で共有する構造にはなっていない。

**他のユーザーがアクセスできない状態を維持すること。**

### `-p` フラグの公式サポート

`claude -p` はヘッドレスモードとして公式にドキュメント化されており、CI/CD、スクリプト、パイプラインからの呼び出しが想定されたユースケースとして案内されている。

## 技術スタック

- Deno
- discord.js v14
- @discordjs/voice（ボイスチャンネル接続）
- Claude Code CLI (`claude -p --output-format stream-json`)
- whisper.cpp（STT、HTTP サーバーモード）
- OpenAI 互換 TTS API（例: voicevox-openai-tts）

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

以下のコマンドは全て `docker/` ディレクトリで実行する。

```bash
cd docker

# ビルド
docker compose build

# 初回認証（コンテナ内で claude auth login を実行）
docker compose run --rm -it bot bash
# コンテナ内で: claude auth login → exit

# 本番起動
docker compose up -d

# 本番停止
docker compose down

# 開発起動（watch モード、ソースコード bind mount。ファイル保存で自動再起動）
docker compose -f compose.yaml -f compose.dev.yaml up

# 開発停止
docker compose -f compose.yaml -f compose.dev.yaml down

# ログ確認
docker compose logs -f

# 停止
docker compose down
```

### ボリューム

| 変数               | コンテナ内パス  | デフォルト                | 用途                                     |
| ------------------ | --------------- | ------------------------- | ---------------------------------------- |
| `CLAUDE_HOME`      | `/root/.claude` | `docker/claude-home`      | 認証情報の永続化                         |
| `CLAUDE_WORKSPACE` | `/workspace`    | `docker/claude-workspace` | ワークスペース（.claude/, CLAUDE.md 等） |

`CLAUDE_HOME` と `CLAUDE_WORKSPACE` は compose.yaml の bind mount 用。コンテナ内のパスは固定。

## ファイル構成

```
main.ts                エントリポイント。dotenv → loadConfig → DiscordBot → start。リトライ付き。
config.ts              環境変数 → Config 型。必須項目のバリデーション。
logger.ts              名前空間付き軽量ロガー。LOG_LEVEL 環境変数で制御。リングバッファで直近ログをメモリ保持。
bot/mod.ts             DiscordBot クラス。messageCreate ハンドラ、start/shutdown。
bot/commands.ts        スラッシュコマンド定義とハンドラ（/claw clear, /claw vc join|leave）。
bot/guard.ts           isAuthorized(): ギルド ID + ユーザー ID + bot 除外の認可チェック。
bot/message.ts         splitMessage(): 2000 文字分割。keepTyping(): typing インジケーター維持。ProgressReporter: ツール進捗表示。
claude/mod.ts          askClaude(): Deno.Command で claude -p を spawn し stream-json 出力を逐次パース。
claude/template.ts     replaceTemplateVariables(): システムプロンプトの {{key}} 置換。
session/mod.ts         SessionStore: チャンネル/スレッド ID → session_id のマッピング。JSON ファイルへの永続化対応。
approval/manager.ts    ApprovalManager: Discord ボタンによるツール承認/拒否。
approval/manager.ts    ApprovalManager: Discord ボタンによるツール承認/拒否。
approval/types.ts      HookInput, ApprovalResult の型定義。
api/server.ts              統合 HTTP サーバー。Hono アプリ作成、サブルートマウント、共通エラーハンドラ。
api/routes/approval.ts     承認フックルート（POST /approval）。
api/routes/cron.ts         cron ルート（GET /cron, POST /cron/run, POST /cron/reload）。
api/routes/discord.ts      Discord REST API ルート + ハンドラ。discord.js Client を通じて Discord を操作。
api/routes/logs.ts         ログ取得ルート（GET /logs）。リングバッファからフィルタ付きで取得。
api/types.ts               API 共通型（ApiContext）。
voice/mod.ts           VoiceManager: VC 接続管理、STT→Claude CLI→TTS パイプライン、auto-join/leave。
voice/adapter.ts       askClaudeForVoice(): askClaude() の SDKMessage ストリームからテキストを抽出するアダプタ。
voice/codec.ts         Opus デコード、PCM→WAV 変換、RMS 計算。
voice/player.ts        VoicePlayer: TTS 合成キュー + AudioPlayer。文単位並列合成で体感遅延を最小化。
voice/tones.ts         処理中・エラー通知トーンの PCM 生成（マリンバ風倍音合成）。
voice/stt.ts           SpeechToText IF + WhisperStt 実装（whisper.cpp HTTP サーバー）。
voice/tts.ts           TextToSpeech IF + OpenAiTts 実装（OpenAI 互換 TTS API）。
cron/types.ts          CronJobDef 型定義。
cron/match.ts          cron 式パーサー + マッチャー。Temporal API でローカルタイム評価。
cron/loader.ts         frontmatter パーサー + cron/ ディレクトリスキャン。
cron/scheduler.ts      CronScheduler: setInterval ベースのカスタムスケジューラ。
cron/executor.ts       CronExecutor: スケジューラ連携 + askClaude() → Discord 送信。
Dockerfile             Deno + Claude Code CLI のコンテナイメージ。
docker/compose.yaml    本番サービス定義。
docker/compose.dev.yaml  開発用オーバーライド（ソース bind mount + watch モード）。
```

## システムプロンプトのテンプレート変数

`.claude/system-prompt/` 配下のファイル内で `{{key}}` 形式のプレースホルダーを使用できる。
`resolve()` 呼び出し時に実際の値で置換される。未定義のキーはそのまま残る。

| 変数                       | 説明                           |
| -------------------------- | ------------------------------ |
| `{{discord.guild.id}}`     | ギルド ID                      |
| `{{discord.guild.name}}`   | ギルド名                       |
| `{{discord.channel.id}}`   | 現在のチャンネル ID            |
| `{{discord.channel.name}}` | 現在のチャンネル名             |
| `{{discord.channel.type}}` | チャンネル種別（text / voice） |
| `{{discord.user.id}}`      | メッセージ送信者の ID          |
| `{{discord.user.name}}`    | メッセージ送信者の名前         |

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

| フィールド      | 必須 | 説明                                          |
| --------------- | ---- | --------------------------------------------- |
| `schedule`      | yes  | cron 式（5フィールド、TZ 依存）               |
| `channelId`     | no   | 指定時: 結果を自動投稿。省略時: 投稿しない    |
| `resumeSession` | no   | 前回セッション引き継ぎ（デフォルト: `false`） |
| `maxTurns`      | no   | `CLAUDE_MAX_TURNS` のオーバーライド           |
| `timeout`       | no   | `CLAUDE_TIMEOUT` のオーバーライド（ms）       |
| `once`          | no   | `true` で1回実行後にファイル自動削除          |

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
2. `shouldRespond()` で反応判定（active channel / mention / スレッド）
3. `message.cleanContent` からプロンプト抽出（bot mention を除去）
4. `keepTyping()` で typing 開始
5. `askClaude()` で `claude -p --output-format stream-json` を実行し、`tool_progress` イベントで進捗表示
6. `SessionStore` にセッション ID 保存（次回 `--resume` で継続）
7. `splitMessage()` で応答を分割送信

### ボイスチャンネル（VOICE_ENABLED=true 時）

1. `/claw vc join` または auto-join で VC に参加
2. Opus フレーム受信 → PCM デコード → RMS フィルタ（ノイズ除去・割り込み検知）
3. 1.5 秒の無音で発話終了を検出、最小長・最小 RMS フィルタ適用
4. thinking tone 開始
5. `WhisperStt.transcribe()` で PCM → テキスト（whisper.cpp HTTP）
6. 発話デバウンス（同一ユーザーの連続発話をマージ）
7. `askClaudeForVoice()` で Claude Code CLI を呼び出し、結果テキストを取得
8. `SessionStore` にセッション ID 保存
9. `VoicePlayer.speak()` でテキストを文単位に TTS 合成 → 音声再生
10. ツール承認が必要な場合は VC テキストチャットに承認ボタンを表示（既存の ApprovalManager を利用）

## Discord REST API

Bot プロセス内で HTTP サーバーを起動し、Discord 操作用の REST API を提供する。
`claude -p` からは Bash + curl で呼び出す。API 仕様は `.claude/skills/discord/SKILL.md` に記載。

### エンドポイント

| メソッド | パス                                             | 説明              |
| -------- | ------------------------------------------------ | ----------------- |
| `GET`    | `/discord/channels`                              | チャンネル一覧    |
| `GET`    | `/discord/channels/:id`                          | チャンネル情報    |
| `GET`    | `/discord/channels/:id/messages`                 | メッセージ検索    |
| `GET`    | `/discord/channels/:id/messages/:mid`            | メッセージ取得    |
| `POST`   | `/discord/channels/:id/messages`                 | メッセージ送信    |
| `POST`   | `/discord/channels/:cid/messages/:mid/reactions` | リアクション追加  |
| `GET`    | `/discord/members`                               | メンバー一覧/検索 |
| `GET`    | `/cron`                                          | cron ジョブ一覧   |
| `POST`   | `/cron/run`                                      | cron 手動実行     |
| `POST`   | `/cron/reload`                                   | cron リロード     |
| `GET`    | `/logs`                                          | ログ取得          |

### 前提条件

- Discord Developer Portal で **Server Members Intent**（Privileged Gateway Intent）を有効にすること。
  メンバー一覧 API に必要。

### 動作の仕組み

1. Bot 起動時（`ClientReady` 後）に `startApiServer()` が `127.0.0.1:{API_PORT}` で HTTP サーバーを起動
2. 承認フック（`POST /approval`）と Discord REST API を同一ポートで提供
3. `claude -p` から Bash ツール経由で `curl` を実行して API を呼び出す

Discord API と承認フックは Bot 起動時に常に有効化される。

## ツール権限

- PreToolUse HTTP フック: Discord にボタンを送信してユーザーが承認/拒否（デフォルト動作）
- `.claude/settings.json` の `permissions.allow`: 事前に許可するツール（ボタン確認をスキップ）
- bypass モード: `claude -p --dangerously-skip-permissions` で全ツール無条件許可（必要時のみ手動で指定）

## 環境変数

`.env.example` 参照。`DISCORD_TOKEN`, `GUILD_ID`, `AUTHORIZED_USER_ID` が必須。

## テスト方針

- 純粋関数（`isAuthorized`, `shouldRespond`, `splitMessage`, `buildArgs`, `parseResultEvent`, `parseNdjsonStream` 等）は単体テストでカバー
- `askClaude()` は `CommandSpawner` の DI でモック（`ReadableStream` を返す）を注入してテスト
- discord.js 依存コード（`bot/mod.ts`, `approval/manager.ts`）はモック化コストが高いため、ロジックを外部関数に抽出してテストする方針
- `defaultSpawner` は実プロセスが必要なためインテグレーションテスト領域
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

- [ ] `--model` 指定: Discord コマンドでモデル切り替え（opus/sonnet/haiku）
- [ ] スレッド自動作成: active channel でのメッセージをスレッドに分離

### テスト・品質

- [ ] `bot/mod.ts` のテスト: DiscordBot クラスの統合テスト
- [ ] `approval/manager.ts` のテスト: ボタンインタラクションのテスト
- [ ] `api/server.ts` のテスト: 統合 HTTP サーバーのテスト

### インフラ

- [ ] CI/CD: GitHub Actions でテスト・lint・型チェックを自動実行
- [ ] Docker イメージのマルチステージビルド: 本番用イメージサイズの削減
- [ ] ヘルスチェック: Docker の healthcheck でプロセス生存確認
