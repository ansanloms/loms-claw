---
name: settings
description: チャンネル / スレッド単位の bot 設定 (model / effort / show_thinking / active / session) を内部 API 経由で取得・変更する手順。設定を確認したいとき、スレッド作成時に初期設定を書き込みたいときに使う。
user-invocable: false
---

# 設定操作 API

bot はチャンネル / スレッド単位で **model / effort / show_thinking / active / session** を Deno KV に永続化している。
Discord のスラッシュコマンド (`/claw settings`) と同じロジックを内部 API 経由で呼べる。

`active` は他の設定と異なり、グローバルデフォルトを持たない。上書きが無ければ `GET` のレスポンスから `active` フィールドごと省略され、`config.json` の `activeChannelIds` によるチャンネル ID リスト判定へフォールバックする (`showThinking` 等のように「未設定なら false / config の値」という単一のデフォルト値には解決できないため)。

## エンドポイント

```
GET    http://127.0.0.1:3000/settings/{id}
PATCH  http://127.0.0.1:3000/settings/{id}
DELETE http://127.0.0.1:3000/settings/{id}
GET    http://127.0.0.1:3000/settings/default
```

## スコープの考え方

`{id}` にはチャンネル ID、スレッド ID、または cron の擬似 id (`cron:{name}`) が入る。

- 通常チャンネル: `{id}` = チャンネル ID
- スレッド: `{id}` = スレッド ID。`GET` では query param `parentId` に親チャンネル ID を付けると thread → channel のフォールバック解決になる。付けない場合はそのスレッド自身に直接設定された値のみを見る (フォールバックしない)。
- `PATCH` / `DELETE` でスレッドを対象にする場合も、`{id}` にスレッド ID をそのまま渡せばよい。書き込み / 削除先は `threadId ?? channelId` (thread があればそれ、無ければ channel) で決まるため、それだけで正しくそのスレッドのスコープに書き込まれる (削除される)。`parentId` は読み取り (`GET`) の解決にのみ使うパラメータで、書き込みには不要なので `PATCH` / `DELETE` は受け取らない。`DELETE` でスレッド ID を指定した場合、消えるのはそのスレッドの設定だけで親チャンネルの設定は残る。

## curl 使用例

```bash
# チャンネルの現在設定を取得
curl -s http://127.0.0.1:3000/settings/1234567890123456789

# スレッドの設定を、親チャンネルへのフォールバックを含めて取得
curl -s 'http://127.0.0.1:3000/settings/9876543210987654321?parentId=1234567890123456789'

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
- 指定できるキーは `model` / `effort` / `showThinking` / `active` / `session`

`session` は `null` による削除のみ受け付ける。任意の値を書き込むことはできない。他スコープの会話セッションを乗っ取れる経路になるため、意図的に禁止されている。会話を引き継ぎたい場合はこの API では実現できない。

`/settings/default` は読み取り専用。書き込み用のエンドポイントは無い (グローバルデフォルトは `config.json` の `claude.defaults` に由来する)。

## レスポンスの `source` の読み方

`GET` / `PATCH` のレスポンスに含まれる `model` / `effort` / `showThinking` は `{ "value": ..., "source": "thread" | "channel" | "default" }` の形。`source` は値の出所を示す。

- `thread`: スレッド固有の値
- `channel`: 親チャンネルの値 (`parentId` を付けて thread → channel フォールバックしたときに、thread 未設定で channel の値を拾った場合)
- `default`: グローバルデフォルト値

注意: **`parentId` を付けずに `{id}` 単独で解決した場合、`channel` はその `{id}` 自身に設定された値を指す** (親子関係の意味ではない)。スレッド ID を `parentId` 無しで叩くと、そのスレッド自身への直接設定が `channel` として返る。

`active` も同じ形で返るが、`source` は `thread` / `channel` のみで `default` にはならない。上書きが無ければ `active` フィールドごとレスポンスから省略される (他の設定と違いグローバルデフォルトを持たないため)。

## PATCH の応答はフォールバックを含まない

`PATCH` は書き込み時に `parentId` を受け取らないため、レスポンスも `{id}` 単独スコープで解決した結果になる。これは上記「`parentId` を付けずに `{id}` 単独で解決した場合」の注意がそのまま当てはまるケースで、スレッドに `PATCH` した直後のレスポンスでも親チャンネルからのフォールバック分 (例: 親チャンネルで設定した `effort`) は含まれない。

スレッドに `PATCH` した後、そのスレッドで実際に効く設定 (フォールバック込み) を確認したい場合は、続けて `parentId` 付きの `GET` を叩く。

```bash
# スレッドに model を設定
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"model":"opus"}' \
  http://127.0.0.1:3000/settings/{スレッドID}

# そのスレッドで実際に効く設定を、親チャンネルへのフォールバックを含めて確認
curl -s 'http://127.0.0.1:3000/settings/{スレッドID}?parentId={親チャンネルID}'
```

## 典型的な使い方

**スレッドを作った直後にそのスレッド固有の model を設定する**

`{id}` に新規スレッド ID をそのまま渡すだけでよい (`parentId` は不要)。

```bash
curl -s -X PATCH -H 'Content-Type: application/json' \
  -d '{"model":"opus"}' \
  http://127.0.0.1:3000/settings/{新規スレッドID}
```

**現在の設定を確認してからユーザに案内する**

```bash
curl -s 'http://127.0.0.1:3000/settings/{チャンネルまたはスレッドID}?parentId={親チャンネルID}'
```
