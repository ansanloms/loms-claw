---
name: settings
description: チャンネル / スレッド単位の bot 設定 (model / effort / showThinking / active / session) を内部 API 経由で取得・変更する手順。設定を確認したいとき、スレッド作成時に初期設定を書き込みたいときに使う。
user-invocable: false
---

# 設定操作 API

bot はチャンネル/スレッド単位で **model / effort / showThinking / active / session** を Deno KV に永続化している。Discord のスラッシュコマンド (`/claw settings`) と同じロジックを内部 API 経由で呼べる。

**キー名に注意**: この API の JSON キーは `showThinking` (camelCase)。Discord スラッシュコマンドのオプション名 `show_thinking` (snake_case) とは異なる。API に `show_thinking` を送ると未知キーとして 400 になる。他の 4 つ (`model`/`effort`/`active`/`session`) は両者で同名。

`active` は他の設定と異なり、グローバルデフォルトを持たない。上書きが無ければ `GET` のレスポンスから `active` フィールドごと省略され、`config.json` の `activeChannelIds` によるチャンネル ID リスト判定へフォールバックする (`showThinking` 等のように「未設定なら false/config の値」という単一のデフォルト値には解決できないため)。

## エンドポイント

```
GET    http://127.0.0.1:3000/settings/{id}
PATCH  http://127.0.0.1:3000/settings/{id}
DELETE http://127.0.0.1:3000/settings/{id}
GET    http://127.0.0.1:3000/settings/default
```

## スコープの考え方

`{id}` にはチャンネル ID、スレッド ID、または cron の擬似 id (`cron:{name}`) が入る。対象の ID を渡すだけでよい。

- 通常チャンネル: `{id}` = チャンネル ID
- スレッド: `{id}` = スレッド ID。`{id}` がスレッドかどうかはサーバが判定し、スレッドであれば thread → channel → default の順でフォールバック解決する。呼び出し側が親子関係を意識する必要はない。
- `PATCH`/`DELETE` でスレッドを対象にする場合も、`{id}` にスレッド ID をそのまま渡せばよい。書き込み/削除先は `threadId ?? channelId` (thread があればそれ、無ければ channel) で決まる。そのため、それだけで正しくそのスレッドのスコープに書き込まれる (削除される)。`DELETE` でスレッド ID を指定した場合、消えるのはそのスレッドの設定だけで親チャンネルの設定は残る。

## curl 使用例

```bash
# チャンネルの現在設定を取得
curl -s http://127.0.0.1:3000/settings/1234567890123456789

# スレッドの設定を、親チャンネルへのフォールバックを含めて取得
curl -s http://127.0.0.1:3000/settings/9876543210987654321

# model / effort をまとめて更新
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"model":"opus","effort":"high"}' \
  http://127.0.0.1:3000/settings/1234567890123456789

# model の設定を削除し、フォールバックへ戻す
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"model":null}' \
  http://127.0.0.1:3000/settings/1234567890123456789

# active を有効化 (mention 不要で全メッセージに反応させる)
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"active":true}' \
  http://127.0.0.1:3000/settings/1234567890123456789

# active の上書きを削除し、config.json の activeChannelIds による判定へ戻す
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"active":null}' \
  http://127.0.0.1:3000/settings/1234567890123456789

# セッションを削除 (次回発話から新規セッション)
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"session":null}' \
  http://127.0.0.1:3000/settings/1234567890123456789

# スコープの設定を全削除
curl -s -X DELETE http://127.0.0.1:3000/settings/1234567890123456789

# グローバルデフォルトを確認 (読み取り専用)
curl -s http://127.0.0.1:3000/settings/default
```

## PATCH の意味論

`PATCH` は JSON Merge Patch (RFC 7386) の意味論に従う。

- キーを省略した場合: その設定は変更しない
- キーに `null` を指定した場合: その設定を削除し、フォールバック解決へ戻す
- 指定できるキーは `model`/`effort`/`showThinking`/`active`/`session`

`session` は `null` による削除のみ受け付ける。任意の値を書き込むことはできない。他スコープの会話セッションを乗っ取れる経路になるため、意図的に禁止されている。会話を引き継ぎたい場合はこの API では実現できない。

`/settings/default` は読み取り専用。書き込み用のエンドポイントは無い (グローバルデフォルトは `config.json` の `claude.defaults` に由来する)。

## キー一覧

| キー           | PATCH で書けるか       | GET に出るか                                          | 取りうる値                                                                                         | 未設定時のフォールバック                                           |
| -------------- | ---------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `model`        | ○                      | `{value, source}`                                     | モデル alias (`opus` / `sonnet` / `haiku`) またはフルネーム (`claude-sonnet-4-6` 等)。空文字は不可 | thread → channel → グローバルデフォルト                            |
| `effort`       | ○                      | `{value, source}`                                     | `low` / `medium` / `high` / `xhigh` / `max` のいずれか                                             | thread → channel → グローバルデフォルト                            |
| `showThinking` | ○                      | `{value, source}`                                     | `true` / `false`                                                                                   | thread → channel → グローバルデフォルト (最終的に `false`)         |
| `active`       | ○                      | `{value, source}`。上書きが無ければフィールドごと省略 | `true` / `false`                                                                                   | `config.json` の `activeChannelIds` によるチャンネル ID リスト判定 |
| `session`      | `null` のみ (削除専用) | **生の文字列**。未設定なら省略                        | 書き込み不可                                                                                       | フォールバックしない (thread と channel で独立)                    |

`null` はどのキーでも「上書きを削除してフォールバックへ戻す」を意味する。`session` だけは `null` 以外を受け付けない。

## レスポンス

### `GET` / `PATCH` の `{id}` 版

`model`/`effort`/`showThinking`/`active` は `{ "value": ..., "source": ... }` の形で返る。`session` だけは生の文字列。

```json
{
  "session": "550e8400-e29b-41d4-a716-446655440000",
  "model": { "value": "opus", "source": "thread" },
  "effort": { "value": "high", "source": "channel" },
  "showThinking": { "value": false, "source": "default" },
  "active": { "value": true, "source": "thread" }
}
```

`source` は値の出所を示す。

- `thread`: スレッド固有の値
- `channel`: 親チャンネルの値 (`{id}` がスレッドで、thread 未設定のため channel の値を拾った場合)
- `default`: グローバルデフォルト値

`showThinking` 以外は未設定ならフィールドごと省略される。上の例は全キーが揃った場合で、実際には省略されたキーがあるほうが普通。`active` の `source` は `thread`/`channel` のみで `default` にはならない。

**`active` は書き込みスコープと実効判定スコープが一致する。** スレッドに `active: true` を書けば、親チャンネルが非 active でもそのスレッドだけ全メッセージに反応する。逆にスレッドに `false` を書けば、親が active でもそのスレッドだけ mention 必須になる。

`PATCH` のレスポンスも `GET` と同じく実効設定 (フォールバック込み) になる。スレッドに `model` だけを `PATCH` しても、親チャンネルで設定済みの `effort` 等はレスポンスにそのまま反映される。**変更後の確認のために追加で `GET` を叩く必要は無い。**

### `/settings/default`

グローバルデフォルトは `source` を持たない。値がそのまま入る。

```json
{
  "model": "claude-sonnet-4-6",
  "effort": "high",
  "showThinking": false
}
```

`model`/`effort` は `config.json` で未設定ならフィールドごと省略される。`showThinking` は必ず入る。`active` と `session` は**含まれない** (グローバルデフォルトを持たないため)。

## 典型的な使い方

### スレッドを作った直後にそのスレッド固有の model を設定する

`{id}` に新規スレッド ID をそのまま渡すだけでよい。

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"model":"opus"}' \
  http://127.0.0.1:3000/settings/{新規スレッドID}
```

### 現在の設定を確認してからユーザに案内する

```bash
curl -s http://127.0.0.1:3000/settings/{チャンネルまたはスレッドID}
```
