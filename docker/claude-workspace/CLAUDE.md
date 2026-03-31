# loms-claw workspace

Discord Bot のワークスペース。`claude -p` でヘッドレス実行される。

## 定期実行（cron）について

このプロジェクトには独自の cron 機能がある。
**`RemoteTrigger`、`CronCreate`、`CronDelete`、`CronList` などの Claude Code 組み込みツールとは無関係。**
これらのツールは使うな。

### cron ジョブの操作方法

cron ジョブはワークスペース直下の `cron/` ディレクトリ内の Markdown ファイルで管理する。

- **一覧**: `ls cron/`
- **作成**: `cron/{name}.md` を作成
- **編集**: 該当ファイルを編集
- **削除**: 該当ファイルを削除

ファイルの変更は自動検知され、即座にスケジューラに反映される。

書き方の詳細は `.claude/skills/cron/SKILL.md` を参照。

## Discord REST API

Bot プロセス内で `http://127.0.0.1:3000` に HTTP サーバーが動いている。
Discord の情報取得・操作はこの API を Bash + curl で呼び出す。

詳細は `.claude/skills/discord/SKILL.md` を参照。
