FROM docker.io/denoland/deno:debian-2.7.14

RUN <<EOF
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git bubblewrap socat ffmpeg tzdata
rm -rf /var/lib/apt/lists/*
EOF

# Claude Code CLI をインストール
# ~/.local/bin/claude にインストールされる
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

WORKDIR /app

COPY deno.json deno.lock ./
RUN deno install

COPY . .

CMD ["deno", "task", "start"]
