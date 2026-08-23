---
name: logs
description: Bot ログ取得 API のリファレンス。エラー調査やデバッグでログを参照するときに使う。
user-invocable: false
---

# ログ参照 API

Bot プロセスはメモリ上に直近のログをリングバッファで保持している。
内部 API 経由で取得できる。

リングバッファは `config.json` の `log.level`（コンソールに出力する最低ログレベル）に関わらず、全レベルのエントリを保持する。そのため `level=DEBUG` を指定すると、標準出力には出ていない DEBUG ログもここから返る。

## エンドポイント

```
GET http://127.0.0.1:3000/logs
```

ポートは固定ではない。`config.json` の `claude.apiPort`（既定 3000）で変わる。

### クエリパラメータ

| パラメータ  | 説明                                       | デフォルト |
| ----------- | ------------------------------------------ | ---------- |
| `level`     | 最低ログレベル（DEBUG / INFO / WARN / ERROR） | 全レベル   |
| `namespace` | 名前空間の前方一致フィルタ                 | なし       |
| `since`     | ISO 8601 タイムスタンプ以降のみ（オフセット必須、下記参照） | なし       |
| `limit`     | 取得件数（1〜1000。1000 を超えると 400）    | 100        |

### `since` はオフセット必須

サーバーは `Temporal.Instant.from()` でパースするため、タイムゾーンオフセット（`+09:00` や `Z`）を省略した文字列は 400 になる。

- 良い例: `2026-08-10T10:00:00+09:00` / `2026-08-10T01:00:00Z`
- 悪い例: `2026-08-10T10:00:00`（オフセット無し、400 エラー）

bot プロセスは `TZ=Asia/Tokyo` で動くため、シェルの現在時刻をそのまま JST で渡してしまいがちだが、オフセットを付けなければ通らない。現在時刻をオフセット付きで得るには次のようにする。

```bash
date -Iseconds
```

## レスポンス

`LogEntry` の配列。`timestamp` / `level` / `namespace` / `message` の 4 フィールドは全件必須。

```json
[
  {
    "timestamp": "2026-04-04T10:30:45.123Z",
    "level": "ERROR",
    "namespace": "claude",
    "message": "claude stderr: ..."
  },
  {
    "timestamp": "2026-04-04T10:30:46.000Z",
    "level": "INFO",
    "namespace": "cron",
    "message": "cron job \"news\" started"
  }
]
```

## curl 使用例

```bash
# 直近のログ（デフォルト100件）
curl -s http://127.0.0.1:3000/logs

# エラーのみ
curl -s 'http://127.0.0.1:3000/logs?level=ERROR'

# claude 関連のログ
curl -s 'http://127.0.0.1:3000/logs?namespace=claude'

# 特定時刻以降の WARN 以上（since はオフセット必須）
curl -s 'http://127.0.0.1:3000/logs?level=WARN&since=2026-04-04T10:00:00%2B09:00'

# 最新 20 件だけ
curl -s 'http://127.0.0.1:3000/logs?limit=20'
```

## 名前空間一覧（網羅）

以下が実在する名前空間の**全て**。ここに無い名前空間を `namespace` に指定してもサーバーはエラーを返さず、単に該当ログが無いだけの空配列 `[]` が 200 で返る。**綴りを間違えると「そのログは存在しない」と誤読するので、必ずこの一覧から選ぶこと。** 廃止済みの内部 Discord API ハンドラ用だった名前空間はこの一覧に存在しない（指定しても常に空配列になる）。

### API 層

| namespace      | 内容                                               |
| -------------- | --------------------------------------------------- |
| `api-server`   | HTTP サーバー全般（Hono アプリ生成、共通エラーハンドラ） |
| `api-cron`     | cron API ルート（一覧・手動実行・reload）           |
| `api-settings` | settings API ルート（チャンネル / スレッド設定の取得・変更） |

### Discord bot 層

| namespace           | 内容                                          |
| -------------------- | --------------------------------------------- |
| `bot`                | Discord メッセージ処理（messageCreate ハンドラ、起動・停止） |
| `commands`           | スラッシュコマンド（`/claw` 系）のハンドラ    |
| `message`             | メッセージ分割送信、typing インジケーター維持 |
| `approval`           | ツール承認フロー（Discord ボタンでの承認・拒否） |
| `approval-settings`  | `.claude/settings.json` の許可リスト読み書き  |
| `question`           | `AskUserQuestion` の質問提示・回答収集        |

### Claude 呼び出し層

| namespace        | 内容                                                     |
| ----------------- | -------------------------------------------------------- |
| `claude`          | Agent SDK の `query()` 呼び出し（開始・終了・エラー）    |
| `system-prompt`   | システムプロンプトの読み込み・コンテキスト別結合         |

### cron 層

| namespace         | 内容                                              |
| ------------------ | -------------------------------------------------- |
| `cron`             | cron ジョブの実行（開始・完了・失敗、重複実行スキップ） |
| `cron-loader`      | `cron/` 配下のジョブファイル読み込み・バリデーション（不正なジョブファイルのエラーはここに出る） |
| `cron-scheduler`   | cron 式のマッチング・スケジュール評価              |

### その他

| namespace | 内容                                       |
| --------- | ------------------------------------------- |
| `main`    | プロセスのエントリポイント（起動・リトライ） |

## エラー調査の手順

1. まず `level=ERROR` でエラーログを確認する。
2. `namespace` でエラーの発生箇所を、上記一覧から選んで絞り込む。
3. `since` で時間帯を絞り、前後の文脈を `level=DEBUG` で取得する（`since` はオフセット必須）。
4. Claude (Agent SDK) の呼び出し失敗時は `namespace=claude&level=ERROR` で詳細が取れる。
5. cron ジョブが reload しても反映されない場合は `namespace=cron-loader&level=ERROR` を確認する（`cron` skill 参照）。

## 異常系

### 接続できない

bot プロセスが停止している、またはポート番号が違うと curl 自体が失敗する（`Connection refused` 等）。ポートは `claude.apiPort` で変わるので、`config.json` を確認するか、まず `bot` へ他のログ（例: `/cron`）が取れるか確かめる。

### 400 が返る

`level` / `since` / `limit` のいずれかが不正なときに `{"error": "..."}` の形で返る。

```json
{"error": "invalid level: FOO. valid: DEBUG, INFO, WARN, ERROR"}
```

```json
{"error": "invalid since: must be ISO 8601"}
```

```json
{"error": "limit must not exceed 1000"}
```

`since` の 400 は多くの場合オフセット省略が原因なので、まずそこを疑う。
