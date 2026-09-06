---
name: backport
description: >-
  稼働サーバ (本番) の実データをローカルの clone へ取り込みたいとき、または backport したいと言われたときに使う。
  `data/config.json` の差分表示と `data/workspace` の rsync 同期をまとめて行う。
---

# 本番データの backport

稼働サーバ (`/opt/services/loms-claw/`) 上の実データをローカルの clone (このリポジトリ) へ取り込む手順。

## いつ使うか

ユーザから次のような依頼があったときに使う。

- 「backport したい」
- 「ceres の状態を取り込みたい」
- 「本番の状態を確認したい」

## 前提

リポジトリ直下に `.env` があり、`LOMS_CLAW_PROD_HOST` (稼働サーバの ssh host alias) と `LOMS_CLAW_PROD_PATH` (稼働サーバ上のデプロイ先ルートパス) が設定されていること。

`.env` が無い、または上記変数が未設定の場合は、リポジトリ直下の `.env.example` を参照してユーザに設定を促すこと。

## 実行手順

リポジトリ直下から、まず `--apply` を付けずに実行して確認する。

```sh
.claude/skills/backport/scripts/backport.sh
```

`data/config.json` の差分と `data/workspace` の削除対象を見て問題なければ、`--apply` を付けて再実行し実際に同期する。

```sh
.claude/skills/backport/scripts/backport.sh --apply
```

## スクリプトが行うこと

- `--apply` の有無に関わらず行うこと
  1. `data/config.json` のローカルとの差分表示 (書き込みはしない)
  2. `data/workspace` の rsync dry-run による削除対象の要約表示 (Deno KV ファイル `*.kv`/`*.kv-shm`/`*.kv-wal` は rsync 対象から除外する)
- `--apply` 付きのときのみ行うこと
  3. `data/workspace` への実際の rsync 同期 (`--delete` あり、本番を正としてローカルを鏡にする。KV ファイルは同様に除外)。同期実行前に main checkout の `data/workspace` に git 管理下のファイルの未コミットの変更が無いか確認し (gitignore されたパスは検査対象外)、あればエラーで中断する (worktree 内から実行しても main checkout が同期先になるため)。
  4. `git status --porcelain data/workspace` によるリポジトリへの影響表示

`--apply` を付けない場合は上記 1〜2 のみ行い、実際の同期は行わずに終了する。

## スクリプトが行わないこと

- `data/config.json` への書き込み。差分が出た場合、取り込むかどうかは人間が個別に判断する。取り込む場合は次のように手動で実行する。`.env` は `source` せず `backport.sh` と同じ抽出方式で読み、失敗時にローカルファイルを壊さないよう一時ファイル経由で反映する（`mv` は使わない。`data/config.json` は Discord トークン等の secrets を含む secrets ファイルであり、最後に `chmod 600` で意図した permission を明示的に強制する）。

  ```sh
  env_file=.env
  extract_env_var() {
    local name="$1" val
    val="$(grep -E "^${name}=" "$env_file" | tail -1 | cut -d= -f2-)" || true
    val="${val%$'\r'}"
    case "$val" in
      \"*)
        val="${val#\"}"
        val="${val%%\"*}"
        ;;
      \'*)
        val="${val#\'}"
        val="${val%%\'*}"
        ;;
      *)
        val="$(printf '%s' "$val" | sed -E 's/[[:space:]]+#.*$//')"
        ;;
    esac
    printf '%s' "$val"
  }
  LOMS_CLAW_PROD_HOST="$(extract_env_var LOMS_CLAW_PROD_HOST)"
  LOMS_CLAW_PROD_PATH="$(extract_env_var LOMS_CLAW_PROD_PATH)"

  tmp="$(mktemp)"
  if ! ssh "$LOMS_CLAW_PROD_HOST" cat "$LOMS_CLAW_PROD_PATH/data/config.json" > "$tmp"; then
    echo "エラー: ssh での本番 config.json 取得に失敗した。" >&2
    rm -f "$tmp"
    exit 1
  fi
  cat "$tmp" > data/config.json && rm -f "$tmp"
  chmod 600 data/config.json
  ```

- `data/home` への一切の操作。root 所有かつ機微情報を含むため対象外。
