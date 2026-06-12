/**
 * Claude Agent SDK (`query()`) の呼び出しモジュール。
 *
 * `@anthropic-ai/claude-agent-sdk` の `query()` を呼び出し、
 * `SDKMessage` のストリームをそのまま逐次 yield する。
 *
 * 旧構成 (`claude -p` を `Deno.Command` で spawn し stream-json を手パース) から
 * 移行した。消費側は従来どおり `SDKMessage` の `type` で分岐する。
 */

import {
  type CanUseTool,
  type Options,
  query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("claude");

/**
 * Agent SDK が対応する effort level。
 */
export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * `query()` 関数の型。テスト時のモック注入用。
 */
export type QueryFn = typeof query;

/**
 * `askClaude` のオプション。
 */
export interface ClaudeCallOptions {
  /** `resume` に渡すセッション ID。 */
  sessionId?: string;
  /** preset システムプロンプトに append する追加プロンプト。 */
  appendSystemPrompt?: string;
  /** `model` に渡すモデル alias または full name。 */
  model?: string;
  /**
   * effort level。`low` / `medium` / `high` / `xhigh` / `max` 以外の値は
   * 未指定扱いにフォールバックする。
   */
  effort?: string;
  /** ツール承認コールバック。省略時は SDK の既定 (default permission mode)。 */
  canUseTool?: CanUseTool;
}

/**
 * effort 値を検証し、SDK 対応の値のみ返す。
 *
 * 非対応の値は警告ログを出して `undefined` を返す。
 */
export function normalizeEffort(effort?: string): EffortLevel | undefined {
  if (!effort) {
    return undefined;
  }
  if ((EFFORT_LEVELS as readonly string[]).includes(effort)) {
    return effort as EffortLevel;
  }
  log.warn(`unsupported effort level ignored: ${effort}`);
  return undefined;
}

/**
 * `ClaudeCallOptions` と `ClaudeConfig` から `query()` の options を構築する。
 *
 * `settingSources: ["user", "project"]` を指定して CLAUDE.md / skills /
 * `.claude/settings.json` の `permissions.allow` を読み込ませる。
 * preset システムプロンプト (`claude_code`) を指定し、アプリ側で組み立てた
 * システムプロンプトを `append` で結合する。
 */
export function buildQueryOptions(
  config: ClaudeConfig,
  opts: ClaudeCallOptions,
  abortController: AbortController,
): Options {
  const effort = normalizeEffort(opts.effort);

  const options: Options = {
    cwd: config.cwd,
    maxTurns: config.maxTurns,
    abortController,
    // CLAUDE.md / skills / settings.json の permissions を読み込む。
    // 省略すると SDK isolation mode となり何も読まれない。
    settingSources: ["user", "project"],
    // 消費側が stream_event (text_delta) を受け取るために必要。
    includePartialMessages: true,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(opts.appendSystemPrompt ? { append: opts.appendSystemPrompt } : {}),
    },
  };

  if (opts.sessionId) {
    options.resume = opts.sessionId;
  }
  if (opts.model) {
    options.model = opts.model;
  }
  if (effort) {
    options.effort = effort;
  }
  if (opts.canUseTool) {
    options.canUseTool = opts.canUseTool;
  }

  return options;
}

/**
 * Claude Agent SDK の `query()` を呼び出し、`SDKMessage` を逐次 yield する。
 *
 * 呼び出し側で `type === "result"` のイベントを拾い、成功時は `"result" in event`
 * で応答テキスト、エラー時は `subtype` / `errors` を参照すること。
 *
 * `query()` 内部で発生した例外は、診断のため受信イベント情報を添えて再 throw する。
 */
export async function* askClaude(
  prompt: string,
  options: ClaudeCallOptions & {
    config: ClaudeConfig;
    signal?: AbortSignal;
    queryFn?: QueryFn;
  },
): AsyncGenerator<SDKMessage> {
  const {
    config,
    signal,
    queryFn = query,
    ...callOpts
  } = options;

  // AbortSignal を AbortController に bridge する (SDK は abortController を受け取る)。
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });
    }
  }

  const queryOptions = buildQueryOptions(config, callOpts, abortController);

  log.debug("starting query:", {
    sessionId: callOpts.sessionId,
    model: callOpts.model,
    effort: queryOptions.effort,
  });

  // エラー時の診断のため、受信したイベント type 列と最後のイベントを保持する。
  const eventTypes: string[] = [];
  let lastEvent: SDKMessage | undefined;

  try {
    for await (const message of queryFn({ prompt, options: queryOptions })) {
      eventTypes.push(message.type);
      lastEvent = message;
      yield message;
    }
  } catch (error: unknown) {
    const reason = getErrorMessage(error);
    const parts: string[] = [
      `claude query failed: ${reason}`,
      eventTypes.length > 0
        ? `  events received (${eventTypes.length}): ${eventTypes.join(", ")}`
        : "  events received: 0 (query died before any output)",
    ];
    if (lastEvent) {
      parts.push(`  last event: ${JSON.stringify(lastEvent).slice(0, 2000)}`);
    }
    log.error(parts.join("\n"));
    throw new Error(`claude query failed: ${reason}`);
  }

  log.info("claude stream completed");
}
