#!/usr/bin/env bash
set -euo pipefail

# worktree 内から実行されることが多いため、main worktree (常に先頭の worktree 行) を
# repo_root として解決する。git rev-parse --show-toplevel だと worktree 自身のパスに
# なってしまい、worktree 削除時に本番データも消える。
# パスにスペースを含む場合に備え、"worktree " プレフィックスを sub で剥がして残り全体を出力する。
repo_root="$(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')"
env_file="$repo_root/.env"

if [ ! -f "$env_file" ]; then
  echo "エラー: $env_file が見つからない。$repo_root/.env.example を参照して作成しろ。" >&2
  exit 1
fi

# .env は docker compose 用ファイル (compose のパース意味論を持つ) であり、bash の
# source で読むと値の意味が変わったり任意のシェルコードとして実行されたりする恐れが
# あるため、必要な2変数だけを個別に抽出する。クォート・インラインコメント・CRLF を
# 素朴に取り除く (過度に汎用的な .env パーサは作らない)。
extract_env_var() {
  local name="$1" file="$2" val
  # grep がマッチ無しで exit 1 を返しても代入自体は空文字列で成功させ、後続の -z チェックに委ねる
  val="$(grep -E "^${name}=" "$file" | tail -1 | cut -d= -f2-)" || true
  val="${val%$'\r'}"
  # クォートで始まる場合は対応する終端クォートまでを値とし、それ以降 (コメント含む) は無視する。
  # クォートで始まらない場合のみ空白+# 以降をインラインコメントとして除去する
  # (先にコメント除去を行うと、クォート内の # まで削れてしまうため順序が重要)
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

LOMS_CLAW_PROD_HOST="$(extract_env_var LOMS_CLAW_PROD_HOST "$env_file")"
LOMS_CLAW_PROD_PATH="$(extract_env_var LOMS_CLAW_PROD_PATH "$env_file")"

if [ -z "$LOMS_CLAW_PROD_HOST" ] || [ -z "$LOMS_CLAW_PROD_PATH" ]; then
  echo "エラー: LOMS_CLAW_PROD_HOST / LOMS_CLAW_PROD_PATH が未設定。$repo_root/.env.example を参照して設定しろ。" >&2
  exit 1
fi

apply=false
if [ "${1:-}" = "--apply" ]; then
  apply=true
fi

# 稼働中の Deno KV ファイルを rsync 対象から外す (中途半端な状態のコピー防止、
# ローカル開発用 KV の上書き防止)。
rsync_exclude=(--exclude='*.kv' --exclude='*.kv-shm' --exclude='*.kv-wal')

remote_config="$(mktemp)"
dry_run_out="$(mktemp)"
trap 'rm -f "$remote_config" "$dry_run_out"' EXIT

echo "=== data/config.json diff (ローカル ← 本番。表示のみ、書き込みはしない) ==="
if ! ssh "$LOMS_CLAW_PROD_HOST" cat "$LOMS_CLAW_PROD_PATH/data/config.json" > "$remote_config"; then
  echo "エラー: ssh での本番 config.json 取得に失敗した。" >&2
  exit 1
fi
# diff は差分があると exit 1 を返すため、set -e で止まらないよう || true で受ける
diff -u "$repo_root/data/config.json" "$remote_config" || true

echo "=== data/workspace dry-run (削除対象の確認) ==="
rsync_status=0
rsync -azin --delete "${rsync_exclude[@]}" "$LOMS_CLAW_PROD_HOST:$LOMS_CLAW_PROD_PATH/data/workspace/" "$repo_root/data/workspace/" > "$dry_run_out" || rsync_status=$?
# exit 24 (稼働中に一部ファイルが消えた) は稼働中ディレクトリの同期では普通に起きるため許容する
if [ "$rsync_status" -ne 0 ] && [ "$rsync_status" -ne 24 ]; then
  echo "エラー: rsync dry-run が失敗した (exit $rsync_status)。" >&2
  cat "$dry_run_out" >&2
  exit 1
fi
# grep はマッチ無しで exit 1 を返すため || echo で受ける
grep '^\*deleting' "$dry_run_out" || echo "(削除対象なし)"

if [ "$apply" != true ]; then
  echo "=== dry-run のみ実行した。実際に同期するには --apply を付けて再実行しろ。 ==="
  exit 0
fi

# repo_root は main worktree 固定 (前述)。worktree 内から --apply すると main checkout の
# data/workspace が同期先になるため、未コミットの変更が無音で上書きされないよう事前に確認する。
pending_changes="$(git -C "$repo_root" status --porcelain -- data/workspace)"
if [ -n "$pending_changes" ]; then
  echo "エラー: main checkout ($repo_root) の data/workspace に未コミットの変更がある。$repo_root でコミットまたは退避してから再実行しろ。" >&2
  echo "$pending_changes" >&2
  exit 1
fi

echo "=== data/workspace 同期実行 ==="
sync_status=0
rsync -az --delete "${rsync_exclude[@]}" "$LOMS_CLAW_PROD_HOST:$LOMS_CLAW_PROD_PATH/data/workspace/" "$repo_root/data/workspace/" || sync_status=$?
if [ "$sync_status" -ne 0 ] && [ "$sync_status" -ne 24 ]; then
  echo "エラー: rsync 同期が失敗した (exit $sync_status)。" >&2
  exit 1
fi

echo "=== git 追跡ファイルへの影響 ==="
git -C "$repo_root" status --porcelain -- data/workspace
