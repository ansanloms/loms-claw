FROM docker.io/denoland/deno:debian-2.8.3

# 実行時データは host の ./data を /data に bind mount する (compose.yaml)。

# Claude Code の設定・認証情報の置き場所 (既定の ~/.claude を置き換える)。
ENV CLAUDE_CONFIG_DIR=/data/home

# アプリが読む設定ファイルのパス。
ENV LOMS_CLAW_CONFIG=/data/config.json

RUN <<EOF
	apt-get update
	apt-get install -y --no-install-recommends ca-certificates curl git bubblewrap socat ffmpeg tzdata
	apt-get clean
	rm -rf /var/lib/apt/lists/*
EOF

WORKDIR /app

COPY deno.json deno.lock ./

# Agent SDK が同梱する Claude Code バイナリを PATH に出す
# (実行時は SDK が自動解決する。symlink は初回認証 `claude auth login` 等の手動操作用)
RUN <<EOF
	set -e
	deno install
	case "$(dpkg --print-architecture)" in
		amd64) sdk_arch="x64" ;;
		arm64) sdk_arch="arm64" ;;
		*) echo "unsupported architecture" >&2; exit 1 ;;
	esac
	ln -sf "${DENO_DIR%/}"/npm/registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-${sdk_arch}/*/claude /usr/local/bin/claude
	claude --version
	# glibc イメージでは musl 用バイナリ (約 230MB) は使われないため削除する。
	# パッケージディレクトリ自体を消すと deno が起動時に再ダウンロードするため、
	# バイナリファイルのみ削除する (パッケージの存在チェックはディレクトリ単位)。
	rm -f "${DENO_DIR%/}"/npm/registry.npmjs.org/@anthropic-ai/claude-agent-sdk-linux-*-musl/*/claude
EOF

COPY . .

# 実行時の cwd はエージェントワークスペース (/data/workspace) にする。
# コードはイメージ焼き込みの /app を絶対パスで参照する。
# 権限フラグは deno.json の start タスクと揃えること
# (deno task は deno.json のあるディレクトリを cwd にするためここでは使えない)。
WORKDIR /data/workspace
CMD ["deno", "run", "--allow-env", "--allow-sys", "--allow-ffi", "--allow-read", "--allow-write", "--allow-net", "--allow-run", "/app/main.ts"]
