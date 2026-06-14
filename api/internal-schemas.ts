// This file was auto-generated from the OpenAPI definition in docs/api.
// Do not make direct changes to the file. Run `deno task generate:internal`.
//
// docs/api の component schema (= JSON Schema)。サーバはこれ 1 枚から
// 型 (json-schema-to-ts の FromSchema) と検証 (@cfworker/json-schema) を得る。

export const internalSchemas = {
  "Channel": {
    "type": "object",
    "description": "Discord チャンネルの概要。",
    "required": [
      "id",
      "name",
      "type",
      "parent_id"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "チャンネル ID。"
      },
      "name": {
        "type": "string",
        "description": "チャンネル名。"
      },
      "type": {
        "type": "string",
        "description": "チャンネル種別。discord.js ChannelType のキー名。",
        "example": "GuildText"
      },
      "parent_id": {
        "type": [
          "string",
          "null"
        ],
        "description": "親カテゴリまたは親チャンネルの ID。無い場合は null。"
      }
    }
  },
  "ChannelDetail": {
    "type": "object",
    "description": "Discord チャンネルの詳細。存在するフィールドのみ返る。",
    "required": [
      "id",
      "type"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "チャンネル ID。"
      },
      "type": {
        "type": "string",
        "description": "チャンネル種別。discord.js ChannelType のキー名。",
        "example": "GuildText"
      },
      "name": {
        "type": "string",
        "description": "チャンネル名。"
      },
      "topic": {
        "type": "string",
        "description": "チャンネルトピック。設定済みの場合のみ返る。"
      },
      "parent_id": {
        "type": "string",
        "description": "親カテゴリまたは親チャンネルの ID。存在する場合のみ返る。"
      },
      "nsfw": {
        "type": "boolean",
        "description": "NSFW フラグ。"
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
  "Member": {
    "type": "object",
    "description": "ギルドメンバー。",
    "required": [
      "id",
      "username",
      "display_name",
      "bot",
      "joined_at",
      "roles"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "ユーザ ID。"
      },
      "username": {
        "type": "string",
        "description": "ユーザ名。"
      },
      "display_name": {
        "type": "string",
        "description": "ギルド内の表示名。"
      },
      "bot": {
        "type": "boolean",
        "description": "Bot ユーザか否か。"
      },
      "joined_at": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time",
        "description": "ギルド参加日時。ISO 8601 形式。不明な場合は null。"
      },
      "roles": {
        "type": "array",
        "description": "付与済みロール一覧。@everyone を除く。",
        "items": {
          "type": "object",
          "required": [
            "id",
            "name"
          ],
          "properties": {
            "id": {
              "type": "string",
              "description": "ロール ID。"
            },
            "name": {
              "type": "string",
              "description": "ロール名。"
            }
          }
        }
      }
    }
  },
  "Message": {
    "type": "object",
    "description": "メッセージの詳細。",
    "required": [
      "id",
      "author",
      "content",
      "created_at",
      "edited_at",
      "attachments",
      "reactions"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "メッセージ ID。"
      },
      "author": {
        "type": "object",
        "description": "投稿者。",
        "required": [
          "id",
          "username",
          "display_name",
          "bot"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "投稿者のユーザ ID。"
          },
          "username": {
            "type": "string",
            "description": "ユーザ名。"
          },
          "display_name": {
            "type": "string",
            "description": "表示名。"
          },
          "bot": {
            "type": "boolean",
            "description": "Bot ユーザか否か。"
          }
        }
      },
      "content": {
        "type": "string",
        "description": "メッセージ本文。"
      },
      "created_at": {
        "type": "string",
        "format": "date-time",
        "description": "投稿日時。ISO 8601 形式。"
      },
      "edited_at": {
        "type": [
          "string",
          "null"
        ],
        "format": "date-time",
        "description": "最終編集日時。ISO 8601 形式。未編集の場合は null。"
      },
      "attachments": {
        "type": "array",
        "description": "添付ファイル一覧。",
        "items": {
          "type": "object",
          "required": [
            "name",
            "url",
            "size"
          ],
          "properties": {
            "name": {
              "type": [
                "string",
                "null"
              ],
              "description": "ファイル名。"
            },
            "url": {
              "type": "string",
              "format": "uri",
              "description": "ダウンロード URL。"
            },
            "size": {
              "type": "integer",
              "description": "ファイルサイズ。単位はバイト。"
            }
          }
        }
      },
      "reactions": {
        "type": "array",
        "description": "リアクション一覧。",
        "items": {
          "type": "object",
          "required": [
            "emoji",
            "count"
          ],
          "properties": {
            "emoji": {
              "type": "string",
              "description": "絵文字の文字列表現。"
            },
            "count": {
              "type": "integer",
              "description": "リアクション数。"
            }
          }
        }
      }
    }
  },
  "MessageSummary": {
    "type": "object",
    "description": "メッセージ検索結果の 1 件。",
    "required": [
      "id",
      "author",
      "content",
      "created_at"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "メッセージ ID。"
      },
      "author": {
        "type": "object",
        "description": "投稿者。",
        "required": [
          "id",
          "username",
          "display_name"
        ],
        "properties": {
          "id": {
            "type": "string",
            "description": "投稿者のユーザ ID。"
          },
          "username": {
            "type": "string",
            "description": "ユーザ名。"
          },
          "display_name": {
            "type": "string",
            "description": "表示名。"
          }
        }
      },
      "content": {
        "type": "string",
        "description": "メッセージ本文。"
      },
      "created_at": {
        "type": "string",
        "format": "date-time",
        "description": "投稿日時。ISO 8601 形式。"
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
  "RequestPostMessage": {
    "type": "object",
    "description": "メッセージ送信リクエスト。",
    "additionalProperties": false,
    "required": [
      "content"
    ],
    "properties": {
      "content": {
        "type": "string",
        "minLength": 1,
        "description": "送信するメッセージ本文。"
      }
    }
  },
  "RequestPostReaction": {
    "type": "object",
    "description": "リアクション追加リクエスト。",
    "additionalProperties": false,
    "required": [
      "emoji"
    ],
    "properties": {
      "emoji": {
        "type": "string",
        "minLength": 1,
        "description": "追加する絵文字。Unicode 絵文字またはカスタム絵文字の文字列表現。"
      }
    }
  },
  "RequestPostThread": {
    "type": "object",
    "description": "スレッド作成リクエスト。",
    "additionalProperties": false,
    "required": [
      "name"
    ],
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 100,
        "description": "スレッド名。1 文字以上 100 文字以下。"
      },
      "auto_archive_duration": {
        "type": "integer",
        "enum": [
          60,
          1440,
          4320,
          10080
        ],
        "default": 1440,
        "description": "自動アーカイブまでの分数。省略時は 1440 (24 時間)。"
      },
      "reason": {
        "type": "string",
        "description": "監査ログに残す理由。"
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
  },
  "ResponsePostMessage": {
    "type": "object",
    "description": "メッセージ送信結果。",
    "required": [
      "id",
      "channel_id"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "作成されたメッセージの ID。"
      },
      "channel_id": {
        "type": "string",
        "description": "送信先チャンネル ID。"
      }
    }
  },
  "ResponsePostReaction": {
    "type": "object",
    "description": "リアクション追加結果。",
    "required": [
      "message_id",
      "emoji"
    ],
    "properties": {
      "message_id": {
        "type": "string",
        "description": "対象メッセージ ID。"
      },
      "emoji": {
        "type": "string",
        "description": "追加した絵文字。"
      }
    }
  },
  "ResponsePostThread": {
    "type": "object",
    "description": "スレッド作成結果。",
    "required": [
      "id",
      "name",
      "parent_id"
    ],
    "properties": {
      "id": {
        "type": "string",
        "description": "作成されたスレッドの ID。"
      },
      "name": {
        "type": "string",
        "description": "スレッド名。"
      },
      "parent_id": {
        "type": [
          "string",
          "null"
        ],
        "description": "親チャンネル ID。"
      }
    }
  }
} as const;
