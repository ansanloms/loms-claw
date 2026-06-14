// This file was auto-generated from the OpenAPI definition in docs/api.
// Do not make direct changes to the file. Run `deno task generate:internal`.
//
// docs/api の component schema (= JSON Schema)。サーバはこれ 1 枚から
// 型 (json-schema-to-ts の FromSchema) と検証 (@cfworker/json-schema) を得る。

export const internalSchemas = {
  "CronJob": {
    "type": "object",
    "description": "登録済み cron ジョブ。",
    "required": [
      "name",
      "schedule"
    ],
    "properties": {
      "name": {
        "type": "string",
        "description": "ジョブ名。ファイル名から決定する。"
      },
      "schedule": {
        "type": "string",
        "description": "cron 式。5 フィールド、TZ 環境変数に依存する。",
        "example": "0 9 * * *"
      },
      "channelId": {
        "type": "string",
        "description": "結果の自動投稿先チャンネル ID。未指定のジョブでは省略される。"
      },
      "once": {
        "type": "boolean",
        "description": "1 回実行後にジョブファイルを自動削除するか。"
      }
    }
  },
  "LogEntry": {
    "type": "object",
    "description": "ログエントリ。",
    "required": [
      "timestamp",
      "level",
      "namespace",
      "message"
    ],
    "properties": {
      "timestamp": {
        "type": "string",
        "format": "date-time",
        "description": "タイムスタンプ。ISO 8601 形式。"
      },
      "level": {
        "type": "string",
        "enum": [
          "DEBUG",
          "INFO",
          "WARN",
          "ERROR"
        ],
        "description": "ログレベル。"
      },
      "namespace": {
        "type": "string",
        "description": "ロガーの名前空間。",
        "example": "api-discord"
      },
      "message": {
        "type": "string",
        "description": "メッセージ本文。引数を含む文字列化済み。"
      }
    }
  },
  "RequestPostCronRun": {
    "type": "object",
    "description": "cron ジョブ手動実行リクエスト。",
    "additionalProperties": false,
    "required": [
      "name"
    ],
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "description": "実行するジョブ名。"
      }
    }
  },
  "ResponseError": {
    "type": "object",
    "description": "エラー応答。Hono の onError および各ハンドラが application/json で返す。",
    "required": [
      "error"
    ],
    "properties": {
      "error": {
        "type": "string",
        "description": "エラーメッセージ。"
      }
    }
  },
  "ResponseGetCron": {
    "type": "object",
    "description": "登録済み cron ジョブ一覧。",
    "required": [
      "jobs"
    ],
    "properties": {
      "jobs": {
        "type": "array",
        "description": "ジョブ一覧。",
        "items": {
          "$ref": "#/components/schemas/CronJob"
        }
      }
    }
  },
  "ResponsePostCronReload": {
    "type": "object",
    "description": "cron 定義の再読み込み結果。",
    "required": [
      "ok"
    ],
    "properties": {
      "ok": {
        "type": "boolean",
        "description": "再読み込みを受け付けたか。"
      }
    }
  },
  "ResponsePostCronRun": {
    "type": "object",
    "description": "cron ジョブ手動実行結果。",
    "required": [
      "ok",
      "name"
    ],
    "properties": {
      "ok": {
        "type": "boolean",
        "description": "実行を受け付けたか。"
      },
      "name": {
        "type": "string",
        "description": "実行したジョブ名。"
      }
    }
  }
} as const;
