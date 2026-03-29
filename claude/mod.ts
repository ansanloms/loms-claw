/**
 * Claude Code CLI (`claude -p`) の呼び出しモジュール。
 *
 * `Deno.Command` でサブプロセスとして `claude` を起動し、
 * `--output-format json` の出力をパースして結果を返す。
 */

import type {
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("claude");

/**
 * Claude Code CLI の応答。
 */
export interface ClaudeResponse {
  /** アシスタントの応答テキスト。 */
  result: string;
  /** セッション ID。`--resume` で会話を継続する際に使う。 */
  sessionId: string;
}

/**
 * PreToolUse HTTP フックの設定 JSON を生成する。
 */
export function buildHookSettings(approvalPort: number): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: `http://127.0.0.1:${approvalPort}/approval`,
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
 */
export function buildArgs(
  prompt: string,
  config: ClaudeConfig,
  sessionId?: string,
): string[] {
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    "--max-turns",
    String(config.maxTurns),
  ];

  if (config.verbose) {
    args.push("--verbose");
  }

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  args.push("--settings", buildHookSettings(config.approvalPort));

  return args;
}

/**
 * Claude Code CLI の stdout をパースして結果を取得する。
 *
 * --verbose 付きだと JSON 配列、なしだと単一オブジェクトが返る。
 * 両方のフォーマットに対応する。
 */
export function parseClaudeOutput(stdout: string): ClaudeResponse {
  if (!stdout.trim()) {
    throw new Error("claude returned empty output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      `claude returned invalid JSON: ${stdout.slice(0, 200)}`,
    );
  }

  // --verbose 付きだと SDKMessage[] 配列、なしだと SDKResultMessage 単体が返る
  const output = (
    Array.isArray(parsed)
      ? parsed.findLast((e: SDKMessage) => e.type === "result")
      : parsed
  ) as SDKResultMessage | undefined;

  if (!output) {
    throw new Error(
      `claude returned no result event: ${stdout.slice(0, 200)}`,
    );
  }

  if (output.is_error) {
    throw new Error(
      `claude returned error: ${
        "result" in output ? output.result : output.subtype
      }`,
    );
  }

  if (!("result" in output) || !output.result) {
    throw new Error(
      `claude returned empty result: ${JSON.stringify(output).slice(0, 200)}`,
    );
  }

  return {
    result: output.result,
    sessionId: output.session_id,
  };
}

/**
 * コマンド実行結果。テスト時のモック用。
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
  code: number;
}

/**
 * コマンド実行関数の型。デフォルトは Deno.Command を使う。
 */
export type CommandSpawner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandResult>;

/**
 * デフォルトのコマンド実行関数。Deno.Command を使う。
 */
export const defaultSpawner: CommandSpawner = async (args, cwd, signal) => {
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

  try {
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.status,
    ]);
    return { stdout, stderr, success: status.success, code: status.code };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

/**
 * Claude Code CLI を呼び出して応答を取得する。
 */
export async function askClaude(
  prompt: string,
  options: {
    sessionId?: string;
    config: ClaudeConfig;
    signal?: AbortSignal;
    spawner?: CommandSpawner;
  },
): Promise<ClaudeResponse> {
  const { config, sessionId, signal, spawner = defaultSpawner } = options;
  const args = buildArgs(prompt, config, sessionId);

  log.debug("spawning claude:", args.join(" "));

  const result = await spawner(args, config.cwd, signal);

  log.debug("claude stdout:", result.stdout.slice(0, 500));
  if (result.stderr.trim()) {
    log.debug("claude stderr:", result.stderr.trim());
  }

  if (!result.success) {
    throw new Error(
      `claude exited with code ${result.code}: ${result.stderr.trim()}`,
    );
  }

  const response = parseClaudeOutput(result.stdout);

  log.info("claude responded, session:", response.sessionId);

  return response;
}
