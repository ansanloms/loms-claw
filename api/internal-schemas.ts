// This file was auto-generated from the OpenAPI definition in docs/api.
// Do not make direct changes to the file. Run `deno task generate:internal`.
//
// docs/api の component schema (= JSON Schema)。サーバはこれ 1 枚から
// 型 (json-schema-to-ts の FromSchema) と検証 (@cfworker/json-schema) を得る。

export const internalSchemas = {
  "BoolSettingEntry": {
    "type": "object",
    "description": "boolean 設定値とその出所。",
    "additionalProperties": false,
    "required": [
      "value",
      "source"
    ],
    "properties": {
      "value": {
        "type": "boolean",
        "description": "解決された設定値。",
        "example": false
      },
      "source": {
        "type": "string",
        "description": "値の出所。thread はスレッド固有値、channel は親チャンネル値、default はグローバルデフォルト値を表す。ただし parentId を指定せず id 単独スコープで解決した場合、channel は id 自身に設定された値を指す。",
        "enum": [
          "thread",
          "channel",
          "default"
        ],
        "example": "default"
      }
    }
  },
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
  "DefaultSettings": {
    "type": "object",
    "description": "config.json の claude.defaults に由来するグローバルデフォルト設定。出所 (source) は持たない。",
    "additionalProperties": false,
    "required": [
      "showThinking"
    ],
    "properties": {
      "model": {
        "type": "string",
        "description": "デフォルトのモデル alias またはフルネーム。config.json で未設定の場合はフィールドごと省略される。",
        "example": "claude-sonnet-4-5"
      },
      "effort": {
        "type": "string",
        "description": "デフォルトの effort レベル。config.json で未設定の場合はフィールドごと省略される。",
        "enum": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
        ],
        "example": "high"
      },
      "showThinking": {
        "type": "boolean",
        "description": "デフォルトの thinking 表示設定。config.json で未設定でも false が入る。",
        "example": false
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
  "ScopeSettings": {
    "type": "object",
    "description": "スコープの解決済み設定。model/effort/showThinking は thread → channel → default の順にフォールバックして解決する。session は thread と channel で独立しており、フォールバックしない。",
    "additionalProperties": false,
    "required": [
      "showThinking"
    ],
    "properties": {
      "session": {
        "type": "string",
        "description": "セッション ID。未設定の場合はフィールドごと省略される。",
        "example": "550e8400-e29b-41d4-a716-446655440000"
      },
      "model": {
        "$ref": "#/components/schemas/SettingEntry"
      },
      "effort": {
        "$ref": "#/components/schemas/SettingEntry"
      },
      "showThinking": {
        "$ref": "#/components/schemas/BoolSettingEntry"
      }
    }
  },
  "SettingEntry": {
    "type": "object",
    "description": "文字列設定値とその出所。",
    "additionalProperties": false,
    "required": [
      "value",
      "source"
    ],
    "properties": {
      "value": {
        "type": "string",
        "description": "解決された設定値。",
        "example": "claude-sonnet-4-5"
      },
      "source": {
        "type": "string",
        "description": "値の出所。thread はスレッド固有値、channel は親チャンネル値、default はグローバルデフォルト値を表す。ただし parentId を指定せず id 単独スコープで解決した場合、channel は id 自身に設定された値を指す。",
        "enum": [
          "thread",
          "channel",
          "default"
        ],
        "example": "channel"
      }
    }
  },
  "RequestPatchSettings": {
    "type": "object",
    "description": "スコープ設定の部分更新リクエスト。JSON Merge Patch (RFC 7386) の意味論に従う。指定しなかったキーは変更せず、値に null を指定したキーは設定を削除してフォールバック解決へ戻す。",
    "additionalProperties": false,
    "minProperties": 1,
    "properties": {
      "model": {
        "type": [
          "string",
          "null"
        ],
        "minLength": 1,
        "description": "モデルの alias またはフルネーム。null を指定すると削除し、フォールバック解決へ戻す。",
        "example": "claude-sonnet-4-5"
      },
      "effort": {
        "type": [
          "string",
          "null"
        ],
        "description": "effort レベル。null を指定すると削除し、フォールバック解決へ戻す。",
        "enum": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          null
        ],
        "example": "high"
      },
      "showThinking": {
        "type": [
          "boolean",
          "null"
        ],
        "description": "thinking 表示設定。null を指定すると削除し、フォールバック解決へ戻す。",
        "example": true
      },
      "session": {
        "type": "null",
        "description": "セッションの削除指定のみを許可する。null 以外の値の書き込みを許可すると、任意のセッション ID を指定して他スコープの会話セッションを乗っ取れる経路になるため、削除以外の操作は許可しない。"
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
  "ResponseDeleteSettings": {
    "type": "object",
    "description": "スコープ設定の削除結果。",
    "additionalProperties": false,
    "required": [
      "ok"
    ],
    "properties": {
      "ok": {
        "type": "boolean",
        "description": "削除を受け付けたか。常に true を返す。",
        "example": true
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
