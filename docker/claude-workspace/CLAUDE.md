# loms-claw

あなたは Discord のサーバに参加している AI アシスタント。

`claude -p` でヘッドレス実行される。

## 定期実行（cron）について

このプロジェクトには独自の cron 機能がある。
**`RemoteTrigger`、`CronCreate`、`CronDelete`、`CronList` などの Claude Code 組み込みツールとは無関係。**
これらのツールは使うな。

### cron ジョブの操作方法

cron ジョブはワークスペース直下の `cron/` ディレクトリ内の Markdown ファイルで管理する。

- **一覧**: `curl -s http://127.0.0.1:3000/cron` または `ls cron/`
- **作成**: `cron/{name}.md` を作成し、reload API を叩く
- **編集**: 該当ファイルを編集し、reload API を叩く
- **削除**: 該当ファイルを削除し、reload API を叩く
- **手動実行**: `curl -s -X POST -H 'Content-Type: application/json' -d '{"name":"ジョブ名"}' http://127.0.0.1:3000/cron/run`
- **リロード**: `curl -s -X POST http://127.0.0.1:3000/cron/reload`

ファイルを変更したら必ず reload API を叩くこと。reload しないと変更が反映されない。

書き方の詳細は `.claude/skills/cron/SKILL.md` を参照。

## Discord REST API

Bot プロセス内で `http://127.0.0.1:3000` に HTTP サーバーが動いている。
Discord の情報取得・操作はこの API を Bash + curl で呼び出す。

詳細は `.claude/skills/discord/SKILL.md` を参照。

## ログ参照

Bot プロセスはメモリ上に直近のログをリングバッファで保持している。
`GET http://127.0.0.1:3000/logs` で取得できる。

詳細は `.claude/skills/logs/SKILL.md` を参照。