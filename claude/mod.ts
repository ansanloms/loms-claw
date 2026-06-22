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
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("claude");

/**
 * Agent SDK が対応する effort level。
 *
 * 値の一覧は {@link EFFORT_LEVELS} を単一ソースとし、型はそこから導出する。
 */
export const EFFORT_LEVELS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

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
  /**
   * Discord bot トークン。指定すると `query()` の env に `DISCORD_BOT_TOKEN`
   * として注入する。discord skill の curl がこの env からトークンを取る
   * (skill 側は config.json を直読みしない)。
   */
  discordToken?: string;
}

/**
 * エラーメッセージが「resume 先のセッションが存在しない」ことを示すか判定する。
 *
 * `resume` に渡した session ID が Claude 側の会話履歴に無い場合、SDK は
 * `No conversation found with session ID: <uuid>` というメッセージで throw する。
 * KV に古い session ID が残ったまま該当セッションが消えている状況で発生する。
 *
 * この判定が真のとき、{@link askClaude} は resume を外して新規セッションで
 * 一度だけやり直す。
 */
export function isSessionNotFoundError(message: string): boolean {
  return message.includes("No conversation found with session ID");
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
 * result イベントから応答テキストを取り出す。
 *
 * `subtype` を問わず `result` フィールドが文字列として含まれていればそれを返す
 * (`error_max_turns` 等でも result があれば採用する)。result が無い場合は
 * `errors` または `subtype` から詳細を組み立てて throw する。
 *
 * 消費側 (chat / cron) で重複していた抽出ロジックを 1 箇所に集約する。
 */
export function extractResultText(event: SDKResultMessage): string {
  if ("result" in event && typeof event.result === "string") {
    return event.result;
  }
  const detail = "errors" in event
    ? JSON.stringify(event.errors)
    : event.subtype ?? "unknown error";
  throw new Error(`claude returned error: ${detail}`);
}

/**
 * SDKMessage がトップレベル (サブエージェント以外) の text_delta なら、
 * その差分テキストを返す。それ以外のイベントは `undefined` を返す。
 *
 * `parent_tool_use_id` が falsy (null / undefined / 未設定) ならトップレベル。
 * chat / voice のストリーミング処理で重複していた抽出ガードを共通化する。
 */
export function extractTopLevelTextDelta(
  event: SDKMessage,
): string | undefined {
  if (event.type !== "stream_event" || event.parent_tool_use_id) {
    return undefined;
  }
  const e = event.event;
  if (
    e.type === "content_block_delta" &&
    "text" in e.delta &&
    e.delta.type === "text_delta"
  ) {
    return e.delta.text;
  }
  return undefined;
}

/**
 * SDKMessage がトップレベル (サブエージェント以外) の thinking_delta なら、
 * その差分テキストを返す。それ以外のイベントは `undefined` を返す。
 *
 * thinking (推論) ブロックは text と同じ `content_block_delta` ストリームに
 * 流れるが `delta.type === "thinking_delta"`、フィールドは `delta.thinking`。
 * thinking が流れるかは model / effort に依存する (effort: low 等では出ない
 * ことがある)。{@link extractTopLevelTextDelta} の thinking 版。
 */
export function extractTopLevelThinkingDelta(
  event: SDKMessage,
): string | undefined {
  if (event.type !== "stream_event" || event.parent_tool_use_id) {
    return undefined;
  }
  const e = event.event;
  if (
    e.type === "content_block_delta" &&
    "thinking" in e.delta &&
    e.delta.type === "thinking_delta"
  ) {
    return e.delta.thinking;
  }
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
    // process.env を明示的に渡す。SDK は env を指定すると process.env を継承しない
    // ため、CLAUDE_CONFIG_DIR 等 (SDK 同梱バイナリが読む) を失わないよう spread する。
    // discord skill は curl の Authorization ヘッダに ${DISCORD_BOT_TOKEN} を使うため、
    // トークンが渡されていれば query() の env に注入する (skill 外から供給する)。
    env: {
      ...Deno.env.toObject(),
      ...(opts.discordToken ? { DISCORD_BOT_TOKEN: opts.discordToken } : {}),
    },
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

  // resume 先のセッションが存在しない場合、resume を外して新規セッションで
  // 一度だけやり直す。stale な session ID が KV に残ったまま Claude 側の会話が
  // 消えているケースを救済する (新しい session_id は呼び出し元が result イベント
  // から保存し直す)。
  let sessionId = callOpts.sessionId;
  let retriedWithoutSession = false;

  while (true) {
    const queryOptions = buildQueryOptions(
      config,
      { ...callOpts, sessionId },
      abortController,
    );

    log.debug("starting query:", {
      sessionId,
      model: callOpts.model,
      effort: queryOptions.effort,
    });

    // エラー時の診断のため、受信したイベント type 列と最後のイベントを保持する。
    const eventTypes: string[] = [];
    let lastEvent: SDKMessage | undefined;
    let caught: unknown;

    try {
      for await (const message of queryFn({ prompt, options: queryOptions })) {
        eventTypes.push(message.type);
        lastEvent = message;
        yield message;
      }
    } catch (error: unknown) {
      caught = error;
    }

    if (caught === undefined) {
      log.info("claude stream completed");
      return;
    }

    const reason = getErrorMessage(caught);

    // resume 先のセッションが見つからない場合のみ、新規セッションで再試行する。
    // このエラーは query 起動時 (まだ何も yield していない時点) に発生するため、
    // 既に何か yield 済みなら再試行しない (下流の二重出力を防ぐ)。
    if (
      sessionId !== undefined &&
      !retriedWithoutSession &&
      eventTypes.length === 0 &&
      isSessionNotFoundError(reason)
    ) {
      log.warn(
        `session ${sessionId} not found, retrying with a new session`,
      );
      sessionId = undefined;
      retriedWithoutSession = true;
      continue;
    }

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
}
