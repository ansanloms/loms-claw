#!/bin/sh
set -u

# cwd はワークスペース (/data/workspace) 前提。GOOGLE_HEALTH_* は bot プロセスの env から継承される。
SKILL_SCRIPTS=".claude/skills/google-health/scripts"

if ! command -v deno >/dev/null 2>&1; then
  echo "deno コマンドが見つからない" >&2
  exit 1
fi

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

STDOUT="$(deno task -q --cwd "$SKILL_SCRIPTS" token-status 2>"$STDERR_FILE")"
CODE=$?

if [ "$CODE" -ne 0 ]; then
  STDERR_LINE="$(head -n 1 "$STDERR_FILE")"
  echo "Google Health のトークンが使えない状態 (失効・未認可・ファイル破損のいずれか)。CLI の出力: ${STDERR_LINE}。#muscle で「Google Health の再認可」と頼めば手順を案内する。"
  exit 0
fi

DAYS="$(printf '%s' "$STDOUT" | jq -r '.refresh_token_expires_in_days' 2>/dev/null)"

case "$DAYS" in
  ''|null|*[!0-9.]*|.|*.*.*)
    echo "token-status の出力を JSON として解釈できなかった: ${STDOUT}" >&2
    exit 1
    ;;
esac

LOW="$(awk -v d="$DAYS" 'BEGIN { print (d < 3) ? 1 : 0 }')"

if [ "$LOW" = "1" ]; then
  echo "Google Health のリフレッシュトークンが残り ${DAYS} 日で失効する。#muscle で「Google Health の再認可」と頼めば手順を案内する。"
fi

exit 0
