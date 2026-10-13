#!/bin/sh
set -u

# cwd はワークスペース (/data/workspace) 前提。GOOGLE_HEALTH_* は bot プロセスの env から継承される。
# npx --prefix には絶対パスを渡す。
SKILL_SCRIPTS="$(pwd)/.claude/skills/google-health/scripts"

STDERR_FILE="$(mktemp)"
trap 'rm -f "$STDERR_FILE"' EXIT

STDOUT="$(npx --no --prefix "$SKILL_SCRIPTS" -- token-status 2>"$STDERR_FILE")"
CODE=$?

STDERR_LINE="$(head -n 1 "$STDERR_FILE")"

if [ "$CODE" -eq 2 ]; then
  echo "Google Health のリフレッシュトークンが失効している。#muscle で「Google Health の再認可」と頼めば手順を案内する。"
  exit 0
fi

if [ "$CODE" -ne 0 ]; then
  echo "token-status で判定できなかった (依存未導入・環境変数の欠落・トークンファイル不在等。apm update 後なら npm ci --omit=dev --prefix \"$SKILL_SCRIPTS\" を実行する)。CLI の出力: ${STDERR_LINE}" >&2
  exit 1
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
