# loms-claw

Discord + Claude Agent SDK のパーソナル AI エージェント。単一ギルド・単一ユーザ専用の bot として Discord のメッセージや定期実行 (cron) を受け、Claude Agent SDK の `query()` で SDK 同梱の Claude Code バイナリをエージェントワークスペース上で動かし、結果を Discord に返す。ランタイムは Deno、Discord 接続は discord.js v14。

## 必要なもの

- Discord bot トークン、対象ギルド ID、操作を許可する唯一のユーザ ID (`data/config.json` に記入する)
- Claude のサブスクリプション (コンテナ内で `claude auth login` により本人が認証する)
- Docker (compose)

利用規約上の注意: 本プロジェクトはサブスクリプション購入者本人がセルフホストし、本人のみが操作できる構成を前提とする。根拠と守るべき不変条件は [docs/terms-of-service.md](docs/terms-of-service.md) を読むこと。

## セットアップ

```bash
cp data/config.json.example data/config.json
# data/config.json を編集し discord.token / discord.guildId / discord.userId を入力

docker compose build

# 初回認証 (コンテナ内で claude auth login を実行し、終わったら exit)
docker compose run --rm -it bot bash

docker compose up -d
```

停止は `docker compose down`、ログは `docker compose logs -f`。実行時データ (`data/`) はコンテナの `/data` に bind mount される。詳細は [docs/architecture/deployment.md](docs/architecture/deployment.md)。

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

PR 作成前は `deno task fix && deno task check && deno task lint && deno task test` を通す ([.claude/rules/pr.md](.claude/rules/pr.md))。

## ドキュメント

- [CLAUDE.md](CLAUDE.md): 開発者・エージェント向けのプロジェクト指示 (規約・不変条件・索引)
- [docs/architecture/README.md](docs/architecture/README.md): アーキテクチャ (全体像・モジュール構成・各章への索引)
- [docs/terms-of-service.md](docs/terms-of-service.md): 利用規約に関する注意
- [docs/api/README.md](docs/api/README.md): 内部 HTTP API の OpenAPI 定義
- [LICENSE](LICENSE)

## ライセンス

MIT License
