FROM docker.io/node:26-bookworm-slim

# 実行時データは host の ./data を /data に bind mount する (compose.yaml)。

# Claude Code の設定・認証情報の置き場所 (既定の ~/.claude を置き換える)。
ENV CLAUDE_CONFIG_DIR=/data/home

# アプリが読む設定ファイルのパス。
ENV LOMS_CLAW_CONFIG=/data/config.json

# ca-certificates: curl / Agent SDK 同梱バイナリの TLS 検証。
# curl: workspace の skill (discord 等) が REST API を叩く手段。healthcheck (compose.yaml) でも使う。
# git: Claude Code (同梱バイナリ) がリポジトリ操作・文脈取得に使う。
# jq: workspace の skill が REST API 応答を整形する手段。healthcheck (compose.yaml) でも使う。
# bubblewrap / socat: Agent SDK 同梱 Claude Code のサンドボックス機能が使う
# (@anthropic-ai/claude-agent-sdk の sdk.mjs に bwrapPath / socatPath 設定がある)。
# ffmpeg: client/discord/message.ts の resizeImageIfNeeded() と bluesky skill が画像リサイズに使う。
# tzdata: compose から渡す TZ を解決するため。
RUN <<EOF
	apt-get update
	apt-get install -y --no-install-recommends ca-certificates curl git jq bubblewrap socat ffmpeg tzdata
	apt-get clean
	rm -rf /var/lib/apt/lists/*
EOF

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY packages/server/package.json packages/server/

RUN <<EOF
	set -e
	npm ci --omit=dev
EOF

COPY . .

# 実行時の cwd はエージェントワークスペース (/data/workspace) にする。
# コードはイメージ焼き込みの /app を絶対パスで参照する。
WORKDIR /data/workspace
CMD ["node", "/app/packages/server/main.ts"]
