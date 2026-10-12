FROM docker.io/node:26-bookworm-slim

# workspace の skill / cron (google-health, mountain-weather, find-docs) が
# Deno を使うため、Deno バイナリを同梱する。docs/api は .dockerignore で
# イメージに入らず、この同梱の理由ではない。
# skill が Deno を離れたら外す (issue #190)。
COPY --from=docker.io/denoland/deno:bin-2.9.7 /deno /usr/local/bin/deno

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
# ffmpeg: bot/message.ts の resizeImageIfNeeded() と bluesky skill が画像リサイズに使う。
# tzdata: compose から渡す TZ を解決するため。
RUN <<EOF
	apt-get update
	apt-get install -y --no-install-recommends ca-certificates curl git jq bubblewrap socat ffmpeg tzdata
	apt-get clean
	rm -rf /var/lib/apt/lists/*
EOF

WORKDIR /app

COPY package.json package-lock.json .npmrc ./

# Agent SDK が同梱する Claude Code バイナリを PATH に出す
# (実行時は SDK が自動解決する。symlink は初回認証 `claude auth login` 等の手動操作用)
RUN <<EOF
	set -e
	npm ci --omit=dev
	case "$(dpkg --print-architecture)" in
		amd64) sdk_arch="x64" ;;
		arm64) sdk_arch="arm64" ;;
		*) echo "unsupported architecture" >&2; exit 1 ;;
	esac
	ln -sf /app/node_modules/@anthropic-ai/claude-agent-sdk-linux-${sdk_arch}/claude /usr/local/bin/claude
	claude --version
EOF

COPY . .

# 実行時の cwd はエージェントワークスペース (/data/workspace) にする。
# コードはイメージ焼き込みの /app を絶対パスで参照する。
WORKDIR /data/workspace
CMD ["node", "/app/main.ts"]
