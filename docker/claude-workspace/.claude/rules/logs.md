# ログ参照

Bot プロセスはメモリ上に直近のログをリングバッファで保持している。
内部 API 経由で取得できる。

## エンドポイント

```
GET http://127.0.0.1:3000/logs
```

### クエリパラメータ

| パラメータ  | 説明                                       | デフォルト |
| ----------- | ------------------------------------------ | ---------- |
| `level`     | 最低ログレベル（DEBUG / INFO / WARN / ERROR） | 全レベル   |
| `namespace` | 名前空間の前方一致フィルタ                 | なし       |
| `since`     | ISO 8601 タイムスタンプ以降のみ            | なし       |
| `limit`     | 取得件数（1〜1000）                        | 100        |

### レスポンス

```json
[
  {
    "timestamp": "2026-04-04T10:30:45.123Z",
    "level": "ERROR",
    "namespace": "claude",
    "message": "claude stderr: ..."
  }
]
```

## 使い方

```bash
# 直近のログ（デフォルト100件）
curl -s http://127.0.0.1:3000/logs

# エラーのみ
curl -s 'http://127.0.0.1:3000/logs?level=ERROR'

# claude 関連のログ
curl -s 'http://127.0.0.1:3000/logs?namespace=claude'

# 特定時刻以降の WARN 以上
curl -s 'http://127.0.0.1:3000/logs?level=WARN&since=2026-04-04T10:00:00Z'

# 最新 20 件だけ
curl -s 'http://127.0.0.1:3000/logs?limit=20'
```

## 主な名前空間

| namespace        | 内容                          |
| ---------------- | ----------------------------- |
| `bot`            | Discord メッセージ処理        |
| `claude`         | Claude CLI の起動・終了       |
| `api-server`     | HTTP サーバー全般             |
| `api-discord`    | Discord REST API ハンドラ     |
| `cron`           | cron ジョブ実行               |
| `cron-scheduler` | cron スケジューラ             |
| `voice-adapter`  | 音声パイプライン              |

## エラー調査の手順

1. まず `level=ERROR` でエラーログを確認する。
2. `namespace` でエラーの発生箇所を絞り込む。
3. `since` で時間帯を絞り、前後の文脈を `level=DEBUG` で取得する。
4. Claude CLI の失敗時は `namespace=claude&level=ERROR` で stderr の詳細が取れる。
