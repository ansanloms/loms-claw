# loms-claw

Discord + Claude Agent SDK のパーソナル AI エージェント。単一ギルド・単一ユーザ専用の bot として Discord のメッセージや定期実行 (cron) を受け、Agent SDK の `query()` で SDK 同梱の Claude Code バイナリをエージェントワークスペース上で動かし、結果を Discord に返す。

このファイルは不変条件・規約・開発手順・ドキュメント索引に絞る。仕組みの記述は [docs/architecture/](docs/architecture/README.md) が正本で、コードと食い違う場合はコードが優先する。

## 利用規約

規約上の根拠・引用・経緯は [docs/terms-of-service.md](docs/terms-of-service.md) にまとめている。実装時に守る不変条件は次の 2 点。

- `bot/guard.ts` の `isAuthorized()` による単一ギルド ID・単一ユーザー ID（サブスクリプション購入者本人）との完全一致要求を崩さない。他のユーザーがアクセスできない状態を維持する。bot 自身の投稿による起動（「AI to AI 自己メンション」）は `isAuthorizedSelfMessage()` で別途判定するが、同一ギルド内の自 bot の投稿に限られ、第三者のリクエストが流入する経路にはならない。
- cron による自動実行の頻度・規模を「個人の通常利用（ordinary, individual usage）」の範囲に保つ。

## 技術スタック

- Deno（`unstable: ["temporal", "kv"]`）
- discord.js v14
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` の `query()`)
- Hono（内部 HTTP API）、Deno KV（スコープ設定の永続化）、`@cfworker/json-schema`（設定・API・cron frontmatter の検証）

## ドキュメント索引

| ドキュメント                                                                       | 内容                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [docs/architecture/README.md](docs/architecture/README.md)                         | 全体像（目的・技術スタック・システムコンテキスト・モジュール依存・ファイル構成）と各章の索引     |
| [docs/architecture/lifecycle.md](docs/architecture/lifecycle.md)                   | 起動 / 終了シーケンス、`config.json` の読み込みと全フィールド、ロガー                            |
| [docs/architecture/message-flow.md](docs/architecture/message-flow.md)             | Discord メッセージ処理の全ステップ、AI to AI 自己メンション、インタラクションの振り分け          |
| [docs/architecture/claude-integration.md](docs/architecture/claude-integration.md) | `askClaude()` と `query()` に渡すオプション、システムプロンプトの結合規則、テンプレート変数      |
| [docs/architecture/store-and-settings.md](docs/architecture/store-and-settings.md) | `Store`（Deno KV）のキー配置とフォールバック、`/claw settings`、`/settings` API                  |
| [docs/architecture/approval.md](docs/architecture/approval.md)                     | ツール承認（`canUseTool`）、`AskUserQuestion`、`permissions.allow`                               |
| [docs/architecture/cron.md](docs/architecture/cron.md)                             | cron ジョブファイルの形式、ローダ / スケジューラ / 実行器、once、reload                          |
| [docs/architecture/internal-api.md](docs/architecture/internal-api.md)             | 内部 HTTP API のルート、`docs/api`（OpenAPI）から `api/internal-schemas.ts` への検証パイプライン |
| [docs/architecture/deployment.md](docs/architecture/deployment.md)                 | Docker / compose / devcontainer、`data/` と環境変数、ワークスペース（`data/workspace/`）の構成   |
| [docs/terms-of-service.md](docs/terms-of-service.md)                               | 利用規約上の根拠・引用・経緯                                                                     |
| [docs/api/README.md](docs/api/README.md)                                           | 内部 HTTP API の OpenAPI 定義（接続条件・エラー応答の形）                                        |
| [data/workspace/CLAUDE.md](data/workspace/CLAUDE.md)                               | ワークスペースで動く Claude（bot の中の Claude）に向けた指示書                                   |

ディレクトリの対応は次のとおり。詳細なファイル構成表は [docs/architecture/README.md](docs/architecture/README.md) にある。

| ディレクトリ / ファイル                                             | 役割                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `main.ts`, `config.ts`, `config.schema.*`, `logger.ts`, `errors.ts` | エントリポイント、設定、ロガー、エラー整形                                                       |
| `bot/`                                                              | Discord 入出力（`DiscordBot`、認可、キュー、レートリミット、メッセージ整形、スラッシュコマンド） |
| `claude/`                                                           | Agent SDK 連携（`askClaude()`、システムプロンプト、テンプレート変数）                            |
| `store/`                                                            | Deno KV によるスコープ設定の永続化                                                               |
| `approval/`                                                         | ツール承認・`AskUserQuestion`・allowlist                                                         |
| `api/`                                                              | 内部 HTTP API（cron / logs / settings）と生成物 `internal-schemas.ts`                            |
| `cron/`                                                             | 定期実行（ローダ・スケジューラ・実行器）                                                         |
| `docs/api/`                                                         | 内部 HTTP API の OpenAPI（独自の `deno.json` を持つ）                                            |
| `data/`                                                             | 実行時データ（`config.json` / `home/` / `workspace/`）。追跡対象は一部のみ                       |

## 開発コマンド

```bash
deno task start      # 起動
deno task dev        # ウォッチモードで起動
deno task test       # テスト + カバレッジ
deno task check      # 型チェック
deno task lint       # lint + format チェック
deno task fix        # lint 自動修正 + format
deno task generate   # docs/api の OpenAPI から api/internal-schemas.ts を再生成
```

- 設定は `data/config.json`（`data/config.json.example` をコピーして必須項目を埋める）。別パスは環境変数 `LOMS_CLAW_CONFIG` で指定する。フィールド一覧は [docs/architecture/lifecycle.md](docs/architecture/lifecycle.md)。
- `api/internal-schemas.ts` は生成物。内部 API のリクエスト / レスポンス形を変えるときは `docs/api/` の YAML を編集して `deno task generate` で再生成し、生成物もコミットする（[docs/architecture/internal-api.md](docs/architecture/internal-api.md)）。
- PR 作成前・push 前の検証チェーンは [.claude/rules/pr.md](.claude/rules/pr.md) に従う。

## Docker

`Dockerfile` / `compose.yaml` はリポジトリルートに置き、コマンドはすべてリポジトリルートで実行する。`data/` を丸ごとコンテナの `/data` へ bind mount し（マウントはこの 1 つだけ）、コンテナ内の cwd は `/data/workspace`（エージェントワークスペース）になる。

```bash
docker compose build                 # ビルド
docker compose run --rm -it bot bash # 初回認証（コンテナ内で claude auth login → exit）
docker compose up -d                 # 本番起動
docker compose down                  # 本番停止
docker compose logs -f               # ログ確認
```

コンテナ内の `claude` コマンドは Agent SDK が同梱する Claude Code バイナリへの symlink で、Claude Code CLI を別途インストールはしない。開発は `.devcontainer/` で行う（本番と同じ compose プロジェクトを使うため、devcontainer 起動中は本番 bot が置き換わる）。Dockerfile の各段、環境変数（`CLAUDE_CONFIG_DIR` / `LOMS_CLAW_CONFIG` / `TZ` / `DISCORD_BOT_TOKEN`）、`data/` のレイアウトは [docs/architecture/deployment.md](docs/architecture/deployment.md)。

## コミット規約

- [Conventional Commits](https://www.conventionalcommits.org/) に準拠する
- コミットメッセージは日本語で記述する
- 例: `feat: Discord ボタンによるツール承認機能を追加`、`fix: セッション ID のパースを修正`

## 実装時の注意

- ワークスペースの `.claude/settings.json` の `permissions.allow` に `AskUserQuestion` を入れない。SDK が `canUseTool` を呼ばず素通しし、回答が空のまま解決される（[docs/architecture/approval.md](docs/architecture/approval.md)）。
- cron 用システムプロンプト（`CRON.md`）ではチャンネル / ユーザー固有のテンプレート変数を使わない。cron ではギルド変数しか渡されず、プレースホルダーのまま残る（[docs/architecture/claude-integration.md](docs/architecture/claude-integration.md)）。
- 日時は `Date` ではなく Temporal を使う（`cron/match.ts`、`bot/ratelimit.ts`、`logger.ts` と同じ流儀）。
- テストコード以外で `deno-lint-ignore` や `any` を使わない。型の絞り込みは type guard で行う。
- 定期実行は本リポジトリ独自の cron 機能（`cron/`）であり、Claude Code 組み込みの `CronCreate` 等とは無関係。

## テスト方針

- 純粋関数（`isAuthorized`, `shouldRespond`, `splitMessage`, `buildQueryOptions`, `normalizeEffort` 等）は単体テストでカバー
- `askClaude()` は `queryFn` の DI でモック（`AsyncGenerator<SDKMessage>` を返す）を注入してテスト
- discord.js 依存コード（`bot/mod.ts`, `approval/manager.ts`）はモック化コストが高いため、ロジックを外部関数に抽出してテストする方針
- 実際の `query()` 実行（SDK 同梱 CLI の spawn）はインテグレーションテスト領域
- テスト実行: `deno task test`（カバレッジレポート付き）

### テスト命名規約

- テスト名は日本語で記述する
- `Deno.test` の名前はモジュール名や関数名（英語のまま）
- `Deno.test` の名前は関数名 / クラス名 / モジュール名のみとし、`X - Y` のような接尾辞は付けない。1 ファイル内の区分は step 名のプレフィックス（`method: …こと`）で行う
- `t.step` の名前は「…こと」「…であること」の形式で記述する

```typescript
Deno.test("isAuthorized", async (t) => {
  await t.step("正しいギルド・ユーザーで許可されること", () => { ... });
  await t.step("bot ユーザーは拒否されること", () => { ... });
});
```

## 課題管理

未対応の課題・既知の乖離は [GitHub Issues](https://github.com/ansanloms/loms-claw/issues) で管理する（2026-08-23 のアーキテクチャ棚卸しで、それまで本ファイルにあった「今後の課題」を含めて issue 化した）。
