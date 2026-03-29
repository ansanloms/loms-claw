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
- Claude Code CLI (`claude -p --output-format json`)

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
logger.ts              名前空間付き軽量ロガー。LOG_LEVEL 環境変数で制御。
bot/mod.ts             DiscordBot クラス。messageCreate ハンドラ、start/shutdown。
bot/commands.ts        スラッシュコマンド定義（/claw clear）。
bot/guard.ts           isAuthorized(): ギルド ID + ユーザー ID + bot 除外の認可チェック。
bot/message.ts         splitMessage(): 2000 文字分割。keepTyping(): typing インジケーター維持。
claude/mod.ts          askClaude(): Deno.Command で claude -p を spawn し JSON 出力をパース。
session/mod.ts         SessionStore: チャンネル/スレッド ID → session_id の Map。
approval/manager.ts    ApprovalManager: Discord ボタンによるツール承認/拒否。
approval/server.ts     承認 HTTP サーバー。PreToolUse フックのエンドポイント。
approval/types.ts      HookInput, ApprovalResult の型定義。
Dockerfile             Deno + Claude Code CLI のコンテナイメージ。
docker/compose.yaml    本番サービス定義。
docker/compose.dev.yaml  開発用オーバーライド（ソース bind mount + watch モード）。
```

## 処理フロー

1. `messageCreate` → `isAuthorized()` で認可チェック
2. `shouldRespond()` で反応判定（active channel / mention / スレッド）
3. `message.cleanContent` からプロンプト抽出（bot mention を除去）
4. `keepTyping()` で typing 開始
5. `askClaude()` で `claude -p --output-format json` を実行
6. `SessionStore` にセッション ID 保存（次回 `--resume` で継続）
7. `splitMessage()` で応答を分割送信

## ツール権限

- PreToolUse HTTP フック: Discord にボタンを送信してユーザーが承認/拒否（デフォルト動作）
- `.claude/settings.json` の `permissions.allow`: 事前に許可するツール（ボタン確認をスキップ）
- bypass モード: `claude -p --dangerously-skip-permissions` で全ツール無条件許可（必要時のみ手動で指定）

## 環境変数

`.env.example` 参照。`DISCORD_TOKEN`, `GUILD_ID`, `AUTHORIZED_USER_ID` が必須。

## テスト方針

- 純粋関数（`isAuthorized`, `shouldRespond`, `splitMessage`, `buildArgs`, `parseClaudeOutput` 等）は単体テストでカバー
- `askClaude()` は `CommandSpawner` の DI でモックスポーナーを注入してテスト
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

- [ ] `--output-format stream-json` 対応: リアルタイム進捗表示（typing 中に「ツール実行中...」等を表示）
- [ ] VC（ボイスチャンネル）対応: discord-vc の STT/TTS パイプラインを統合
- [ ] セッション永続化: プロセス再起動時のセッション復元（現在はインメモリ Map で再起動で消える）
- [ ] `--model` 指定: Discord コマンドでモデル切り替え（opus/sonnet/haiku）
- [ ] スレッド自動作成: active channel でのメッセージをスレッドに分離

### テスト・品質

- [ ] `bot/mod.ts` のテスト: DiscordBot クラスの統合テスト
- [ ] `approval/manager.ts` のテスト: ボタンインタラクションのテスト
- [ ] `approval/server.ts` のテスト: HTTP エンドポイントのテスト

### インフラ

- [ ] CI/CD: GitHub Actions でテスト・lint・型チェックを自動実行
- [ ] Docker イメージのマルチステージビルド: 本番用イメージサイズの削減
- [ ] ヘルスチェック: Docker の healthcheck でプロセス生存確認
