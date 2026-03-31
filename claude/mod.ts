/**
 * Claude Code CLI (`claude -p`) の呼び出しモジュール。
 *
 * `Deno.Command` でサブプロセスとして `claude` を起動し、
 * `--output-format stream-json` の NDJSON 出力を逐次パースして結果を返す。
 */

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { TextLineStream } from "@std/streams";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("claude");

/**
 * PreToolUse HTTP フックの設定 JSON を生成する。
 */
export function buildHookSettings(apiPort: number): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: `http://127.0.0.1:${apiPort}/approval`,
              timeout: 300,
            },
          ],
        },
      ],
    },
  });
}

/**
 * `claude -p` の引数を構築する。
 *
 * tool_progress 等のイベントを受け取るため `--verbose` を強制する。
 */
export function buildArgs(
  prompt: string,
  config: ClaudeConfig,
  sessionId?: string,
  appendSystemPrompt?: string,
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(config.maxTurns),
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  if (appendSystemPrompt) {
    args.push("--append-system-prompt", appendSystemPrompt);
  }

  args.push("--settings", buildHookSettings(config.apiPort));

  return args;
}

/**
 * コマンド実行の結果。
 */
export interface SpawnResult {
  /** stdout の ReadableStream。NDJSON 行が流れる。 */
  stdout: ReadableStream<Uint8Array>;
  /** stderr の全内容（プロセス終了後に resolve される）。 */
  stderr: Promise<string>;
  /** プロセスの終了ステータス。 */
  status: Promise<Deno.CommandStatus>;
}

/**
 * コマンド実行関数の型。テスト時のモック注入用。
 */
export type CommandSpawner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => SpawnResult;

/**
 * デフォルトのコマンド実行関数。Deno.Command を使う。
 */
export const defaultSpawner: CommandSpawner = (args, cwd, signal) => {
  const command = new Deno.Command("claude", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    cwd,
  });

  const child = command.spawn();

  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // プロセスが既に終了している場合は無視
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    stdout: child.stdout,
    stderr: new Response(child.stderr).text(),
    status: child.status.finally(() => {
      signal?.removeEventListener("abort", onAbort);
    }),
  };
};

/**
 * ReadableStream<Uint8Array> を NDJSON として行ごとにパースし、
 * SDKMessage を yield する AsyncGenerator。
 *
 * 不正な JSON 行はログ出力してスキップする。
 */
export async function* parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SDKMessage> {
  const lines = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());

  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    let parsed: SDKMessage;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.warn("skipping invalid NDJSON line:", line.slice(0, 200));
      continue;
    }

    yield parsed;
  }
}

/**
 * Claude Code CLI をストリーミングモードで呼び出し、
 * SDKMessage を逐次 yield する。
 *
 * 呼び出し側で `type === "result"` のイベントを拾い、
 * `type === "result"` のイベントから結果を取得すること。
 * 成功時は `"result" in event` で応答テキスト、エラー時は `event.errors` を参照。
 */
export async function* askClaude(
  prompt: string,
  options: {
    sessionId?: string;
    config: ClaudeConfig;
    signal?: AbortSignal;
    spawner?: CommandSpawner;
    appendSystemPrompt?: string;
  },
): AsyncGenerator<SDKMessage> {
  const {
    config,
    sessionId,
    signal,
    spawner = defaultSpawner,
    appendSystemPrompt,
  } = options;
  const args = buildArgs(prompt, config, sessionId, appendSystemPrompt);

  log.debug("spawning claude:", args.join(" "));

  const { stdout, stderr, status } = spawner(args, config.cwd, signal);

  yield* parseNdjsonStream(stdout);

  const [stderrText, exitStatus] = await Promise.all([stderr, status]);

  if (stderrText.trim()) {
    log.debug("claude stderr:", stderrText.trim());
  }

  if (!exitStatus.success) {
    throw new Error(
      `claude exited with code ${exitStatus.code}: ${stderrText.trim()}`,
    );
  }

  log.info("claude stream completed");
}
