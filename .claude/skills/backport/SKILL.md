---
name: backport
description: >-
  稼働サーバ (本番) の実データをローカルの clone へ取り込みたいとき、または backport したいと言われたときに使う。
  `data/config.json` の差分表示と `data/workspace` の rsync 同期を行う。
---

# 本番データの backport

稼働サーバ上の実データをローカルの clone (このリポジトリ) へ取り込む手順。

## いつ使うか

ユーザから次のような依頼があったときに使う。

- 「backport したい」
- 「本番の状態を取り込みたい」
- 「稼働サーバの状態を確認したい」

## 前提

リポジトリ直下に `.env` があり、次の 2 つが設定されていること。

- `LOMS_CLAW_PROD_HOST`: 稼働サーバの ssh host alias
- `LOMS_CLAW_PROD_PATH`: 稼働サーバ上のデプロイ先ルートパス

`.env` が無い、または上記変数が未設定の場合は、リポジトリ直下の `.env.example` を参照してユーザに設定を促すこと。

## 手順

1. `.env` を読み、`LOMS_CLAW_PROD_HOST` と `LOMS_CLAW_PROD_PATH` の値を確認する。以降のコマンド例の `<host>` `<path>` はこれらの実際の値に置き換えて実行すること。
2. `data/config.json` の差分を表示する (書き込みはしない)。
   ```sh
   diff -u data/config.json <(ssh <host> cat <path>/data/config.json)
   ```
3. `git status --porcelain data/workspace` を確認する。非空の場合 (main checkout の `data/workspace` に未コミットの変更がある場合)、その内容をユーザに示し、進めてよいか確認してから次に進む。
4. `data/workspace` の dry-run で削除・更新対象を確認する。Deno KV ファイルは稼働中のデータベースであり中途半端な状態でコピーされると壊れるため、常に除外する。
   ```sh
   rsync -azn --delete --exclude='*.kv' --exclude='*.kv-shm' --exclude='*.kv-wal' <host>:<path>/data/workspace/ data/workspace/
   ```
5. 表示された内容 (特に削除対象) をユーザに示し、問題なければ実同期する。
   ```sh
   rsync -az --delete --exclude='*.kv' --exclude='*.kv-shm' --exclude='*.kv-wal' <host>:<path>/data/workspace/ data/workspace/
   ```
6. `git status --porcelain data/workspace` で最終的な影響を確認し、ユーザに報告する。

## 行わないこと

- `data/config.json` への書き込み。手順 2 の差分を見て、取り込むかどうかは人間が個別に判断する。取り込む場合は次のように手動で実行する。

  ```sh
  ssh <host> cat <path>/data/config.json > data/config.json
  ```

- `data/home` への一切の操作。root 所有かつ機微情報を含むため対象外。
