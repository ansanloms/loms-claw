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
 * `buildArgs` / `askClaude` のオプション。
 */
export interface ClaudeCallOptions {
  /** `--resume` に渡すセッション ID。 */
  sessionId?: string;
  /** `--append-system-prompt` に渡す追加プロンプト。 */
  appendSystemPrompt?: string;
  /** `--model` に渡すモデル alias または full name。 */
  model?: string;
  /** `--effort` に渡す effort level (low / medium / high / xhigh / max)。 */
  effort?: string;
}

/**
 * `claude -p` の引数を構築する。
 *
 * tool_progress 等のイベントを受け取るため `--verbose` を強制する。
 */
export function buildArgs(
  prompt: string,
  config: ClaudeConfig,
  opts: ClaudeCallOptions = {},
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

  if (opts.sessionId) {
    args.push("--resume", opts.sessionId);
  }

  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  if (opts.model) {
    args.push("--model", opts.model);
  }

  if (opts.effort) {
    args.push("--effort", opts.effort);
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
 *
 * エラー時の診断のため、受信したイベント数 / 最後のイベント / parser が弾いた
 * 非 JSON 行 / args を dump する。stderr が空でも root cause が追えるように。
 */
export async function* askClaude(
  prompt: string,
  options: ClaudeCallOptions & {
    config: ClaudeConfig;
    signal?: AbortSignal;
    spawner?: CommandSpawner;
  },
): AsyncGenerator<SDKMessage> {
  const {
    config,
    signal,
    spawner = defaultSpawner,
    ...callOpts
  } = options;
  const args = buildArgs(prompt, config, callOpts);

  log.debug("spawning claude:", args.join(" "));

  const { stdout, stderr, status } = spawner(args, config.cwd, signal);

  // 診断情報 (eventTypes / lastEvent / invalidLines) を収集するため、
  // parseNdjsonStream をそのまま使わずに inline でパースする。
  // parseNdjsonStream の挙動を変える場合は、この inline 版も合わせて見直すこと。
  const eventTypes: string[] = [];
  let lastEvent: SDKMessage | undefined;
  const invalidLines: string[] = [];
  const MAX_INVALID = 10;

  const lines = stdout
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
      log.warn("skipping invalid NDJSON line:", line.slice(0, 500));
      if (invalidLines.length < MAX_INVALID) {
        invalidLines.push(line);
      }
      continue;
    }
    eventTypes.push(parsed.type);
    lastEvent = parsed;
    yield parsed;
  }

  const [stderrText, exitStatus] = await Promise.all([stderr, status]);

  if (!exitStatus.success) {
    const trimmedStderr = stderrText.trim();
    const signalPart = exitStatus.signal
      ? ` (signal: ${exitStatus.signal})`
      : "";

    const parts: string[] = [
      `claude exited with code ${exitStatus.code}${signalPart}`,
      eventTypes.length > 0
        ? `  events received (${eventTypes.length}): ${eventTypes.join(", ")}`
        : "  events received: 0 (claude died before any output)",
    ];
    if (lastEvent) {
      parts.push(
        `  last event: ${JSON.stringify(lastEvent).slice(0, 2000)}`,
      );
    }
    if (invalidLines.length > 0) {
      parts.push(
        `  non-JSON stdout lines (${invalidLines.length}):\n    ${
          invalidLines.map((l) => l.slice(0, 500)).join("\n    ")
        }`,
      );
    }
    if (trimmedStderr) {
      parts.push(`  stderr:\n    ${trimmedStderr.replace(/\n/g, "\n    ")}`);
    } else {
      parts.push("  stderr: (empty)");
    }
    parts.push(`  args: ${JSON.stringify(args)}`);
    log.error(parts.join("\n"));

    // Discord 側にも root cause のヒントを返す
    const reason = extractReason({
      lastEvent,
      eventTypesCount: eventTypes.length,
      invalidLines,
      stderr: trimmedStderr,
    });
    throw new Error(
      `claude exited with code ${exitStatus.code}${signalPart}: ${reason}`,
    );
  }

  if (stderrText.trim()) {
    log.debug("claude stderr:", stderrText.trim());
  }

  log.info("claude stream completed");
}

/**
 * エラーメッセージ用に root cause の短い説明を組み立てる。
 *
 * 優先順: stderr → 非 JSON 出力 → result subtype → イベント未受信 → unknown。
 */
function extractReason(input: {
  lastEvent?: SDKMessage;
  eventTypesCount: number;
  invalidLines: string[];
  stderr: string;
}): string {
  if (input.stderr) {
    return input.stderr.slice(0, 500);
  }
  if (input.invalidLines.length > 0) {
    return `non-JSON stdout: ${input.invalidLines[0].slice(0, 300)}`;
  }
  const last = input.lastEvent;
  if (last && last.type === "result" && "subtype" in last) {
    const errors = "errors" in last && last.errors
      ? ` errors=${JSON.stringify(last.errors).slice(0, 300)}`
      : "";
    return `result subtype=${last.subtype}${errors}`;
  }
  if (input.eventTypesCount === 0) {
    return "no output (claude did not start?)";
  }
  return `last event type=${last?.type ?? "unknown"}`;
}
