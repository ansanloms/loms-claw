# loms-claw

Discord + Claude Agent SDK のパーソナル AI エージェント。単一ギルド・単一ユーザ専用の bot として Discord のメッセージや定期実行 (cron) を受け、Agent SDK の `query()` で SDK 同梱の Claude Code バイナリをエージェントワークスペース上で動かし、結果を Discord に返す。

このブランチ (`next`) は作り直しの途中で、実装は土台 (API の起動と `GET /health`) だけである。I/F の定義は [docs/api/](docs/api/README.md) にある。要る部品は main から持ち込む。

このファイルは不変条件・規約・開発手順・ドキュメント索引に絞る。

## 利用規約

規約上の根拠・引用・経緯は [docs/terms-of-service.md](docs/terms-of-service.md) にまとめている。実装時に守る不変条件は次の 2 点。

- 単一ギルド ID・単一ユーザー ID（サブスクリプション購入者本人）との完全一致を要求し続ける。他のユーザーがアクセスできない状態を維持する。bot 自身の投稿による起動（「AI to AI 自己メンション」）は別途判定するが、同一ギルド内の自 bot の投稿に限られ、第三者のリクエストが流入する経路にしない。
- cron による自動実行の頻度・規模を「個人の通常利用（ordinary, individual usage）」の範囲に保つ。

## 構成

npm workspaces (`packages/*`) で package に分ける。依存は package ごとに宣言し、直下の `package.json` は scripts と開発ツールだけを持つ。

- `packages/server`: `@loms-claw/server`。本体で、入口は `packages/server/main.ts`。型生成の道具 (`openapi-typescript` と TypeScript 5) は `devDependencies` に持つ。
- `docs/api`: API 定義の文書。package にせず、独立のまま。
- client (Discord 等) は、server とは別プロセスで動く package として `packages/` に足す予定。

## 技術スタック

- Node.js 26（TypeScript は型除去で直接実行。`Temporal` は `@js-temporal/polyfill` を各ファイルで import する。Node が組み込みで提供したら外す）
- discord.js v14
- croner（cron 式のパースと一致判定）
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` の `query()`)
- Hono + `@hono/node-server`（内部 HTTP API）
- SQLite（`node:sqlite`。永続化）
- `@cfworker/json-schema`（設定・API・cron frontmatter の検証）

この一覧は完成時の構成で、まだ実装の無い機能の依存（discord.js・croner・Agent SDK・`@js-temporal/polyfill` 等）は入っていない。最初に使う package の `dependencies` に足す。

## ドキュメント索引

| ドキュメント                                         | 内容                                  |
| ---------------------------------------------------- | ------------------------------------- |
| [docs/api/README.md](docs/api/README.md)             | 次期 I/F (REST / SSE) の OpenAPI 定義 |
| [docs/terms-of-service.md](docs/terms-of-service.md) | 利用規約上の根拠・引用・経緯          |

## 開発コマンド

```bash
npm run start      # 起動
npm run dev        # ウォッチモードで起動
npm test           # テスト + カバレッジ
npm run check      # 型チェック（tsc --noEmit）
npm run generate   # docs/api の定義から packages/server/api/openapi.gen.* を再生成
npm run lint       # lint + format チェック（oxlint + oxfmt --check）
npm run fix        # lint 自動修正 + format（oxlint --fix + oxfmt）
```

- 初回と依存更新後は `npm ci`・`npm --prefix docs/api ci` が先に要る。
- 型検査は直下の `npm run check` で回す (`packages/server` の下には生成用の TypeScript 5 が入る)。
- `docs/api` の検証は `npm --prefix docs/api run lint` と `npm --prefix docs/api test`。
- CI (`.github/workflows/ci.yml`) は PR と `main`・`next` への push で、直下の `check`・`lint`・`test` (`root`)、生成物の差分検査 (`generated`)、`docs/api` の `lint`・`test` (`docs-api`)、`docker build .` (`docker`) を回す。`verify-lockfile.yml` は `gh actions-lock --verify` で lockfile を検証する。
- workflow の action を足す・上げるときは `gh actions-lock --no-interactive` で `.github/workflows/actions.lock` を更新する。

## コミット規約

- [Conventional Commits](https://www.conventionalcommits.org/) に準拠する
- コミットメッセージは日本語で記述する
- 例: `feat: Discord ボタンによるツール承認機能を追加`、`fix: セッション ID のパースを修正`

## 実装時の注意

- 日時は `Date` ではなく Temporal を使う。Node にはグローバルの `Temporal` が無いため、`import { Temporal } from "@js-temporal/polyfill"` を各ファイルで書く。
- テストコード以外で `oxlint-disable-next-line` や `any` を使わない。型の絞り込みは type guard で行う。
- Node の型除去で落ちる構文（parameter property、`enum`、`namespace`、角括弧アサーション `<T>expr`）を使わない。`tsc` の `erasableSyntaxOnly` が検出する。
- 相対 import には `.ts` 拡張子を付ける（Node は拡張子無しの相対 import を解決しない）。
- `packages/server/api/openapi.gen.*` は生成物で、手で編集しない。`docs/api` の定義を変えたら `npm run generate` を回して差分をコミットする。

## テスト方針

次の方針は main の実装のもので、消したファイルへの言及を含む。実装を持ち込む時に見直す。

- `Conversation` は fake の `TurnOutput` と `queryFn` のモックでテストする（`core/conversation.test.ts`）。`CronExecutor` は fake の `CronPorts` でテストする
- 純粋関数（`isAuthorized`, `shouldRespond`, `splitMessage`, `buildQueryOptions`, `normalizeEffort` 等）は単体テストでカバー
- `askClaude()` は `queryFn` の DI でモック（`AsyncGenerator<SDKMessage>` を返す）を注入してテスト
- discord.js 依存コード（`client/discord/mod.ts`, `client/discord/approval/manager.ts`）はモック化コストが高いため、ロジックを外部関数に抽出してテストする方針
- 実際の `query()` 実行（SDK 同梱 CLI の spawn）はインテグレーションテスト領域
- `client/discord/message.ts` の `downloadImageAttachments`/`resizeImageIfNeeded`（ffprobe/ffmpeg の spawn を伴う）もインテグレーションテスト領域とし、単体テストの対象外とする
- テスト実行: `npm test`（カバレッジレポート付き）

### テスト命名規約

- テスト名は日本語で記述する
- `describe` の名前はモジュール名/関数名/クラス名（英語のまま）とし、`X - Y` のような接尾辞は付けない。複数の関数・メソッドを 1 つの `describe` にまとめる場合は、`test` 名に `method: …こと` のプレフィックスを付けて区分する
- `test` の名前は「…こと」「…であること」の形式で記述する
- assertion は `node:assert/strict` の default import を使う（非 strict の `node:assert` は使わない。`node:test` の `describe` / `test` と組み合わせる）
- エラーの検証は `test-helpers.ts` の `errorWith()` を使う

```typescript
import assert from "node:assert/strict";
import { describe, test } from "node:test";

describe("isAuthorized", () => {
  test("正しいギルド・ユーザーで許可されること", () => {
    assert.deepStrictEqual(isAuthorized(...), true);
  });
  test("bot ユーザーは拒否されること", () => { ... });
});
```

## 課題管理

未対応の課題・既知の乖離は [GitHub Issues](https://github.com/ansanloms/loms-claw/issues) で管理する（2026-08-23 のアーキテクチャ棚卸しで、それまで本ファイルにあった「今後の課題」を含めて issue 化した）。
