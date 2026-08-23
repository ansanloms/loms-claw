# loms-claw Internal API

loms-claw が Bot プロセス内で起動する内部 HTTP API の定義。

cron ジョブ・ログ取得・チャンネル設定の操作を単一ポートで提供する。
Claude (Agent SDK) の Bash ツールから `curl` 経由で呼び出す用途を想定する。

## 接続

- ホスト: `127.0.0.1` 固定。in-process 専用であり外部へは公開しない。
- ポート: `config.json` の `claude.apiPort`。既定値は `3000`。
- 認証: なし。ローカルバインドのため認証機構を持たない。

## エラー応答

エラー時は HTTP ステータスコードと `application/json` の `{ "error": string }` を返す。
RFC 9457 Problem Details 形式ではない。`GET /health` のみ例外で、503 時も `{ "status": "unavailable" }` を返す。

## schema の additionalProperties 方針

`components/schemas/*.yaml` の `additionalProperties: false` は、リクエストボディの schema と、それが `$ref` で参照する schema にのみ付ける。レスポンス専用の schema には付けない（将来のフィールド追加を許容するため）。

## 補足

ツール承認は SDK の `canUseTool` コールバックで in-process に処理するため、対応する HTTP エンドポイントを持たない。
