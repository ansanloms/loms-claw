/**
 * Claude Code CLI と音声パイプラインのアダプタ。
 *
 * askClaude() が返す SDKMessage ストリームから結果テキストを抽出し、
 * 音声パイプラインが消費しやすい形で返す。
 *
 * streamClaudeForVoice() はストリーミング対応版で、text_delta を
 * 文単位で逐次 yield し、TTS の体感遅延を最小化する。
 */

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  askClaude,
  type ClaudeCallOptions,
  type CommandSpawner,
} from "../claude/mod.ts";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("voice-adapter");

/**
 * streamClaudeForVoice が yield するイベント。
 */
export type VoiceStreamEvent =
  | { type: "text"; text: string }
  | { type: "end"; sessionId: string };

/**
 * askClaudeForVoice の戻り値。
 */
export interface VoiceResult {
  /** Claude の応答テキスト。 */
  text: string;
  /** セッション ID（SessionStore に保存する）。 */
  sessionId: string;
}

/**
 * Claude Code CLI を呼び出し、結果テキストとセッション ID を返す。
 *
 * askClaude() の SDKMessage ストリームを走査し、result イベントから
 * テキストを抽出する。ストリーミングチャンクではなく最終結果を
 * 一括で返すため、呼び出し側は結果全体を VoicePlayer.speak() に渡す。
 *
 * @param prompt - ユーザーの発話テキスト。
 * @param options - Claude CLI オプション。
 * @returns テキストとセッション ID。
 * @throws 結果イベントが無い場合、またはエラーイベントの場合。
 */
export async function askClaudeForVoice(
  prompt: string,
  options: ClaudeCallOptions & {
    config: ClaudeConfig;
    signal?: AbortSignal;
    spawner?: CommandSpawner;
  },
): Promise<VoiceResult> {
  const stream = askClaude(prompt, options);
  let resultEvent: SDKResultMessage | undefined;

  for await (const event of stream) {
    if (event.type === "result") {
      resultEvent = event;
    }
  }

  if (!resultEvent) {
    throw new Error("claude stream ended without result event");
  }

  if ("result" in resultEvent && typeof resultEvent.result === "string") {
    log.info(
      `claude response: ${resultEvent.result.slice(0, 100)}${
        resultEvent.result.length > 100 ? "..." : ""
      }`,
    );
    return {
      text: resultEvent.result,
      sessionId: resultEvent.session_id,
    };
  }

  const errors = "errors" in resultEvent
    ? JSON.stringify(resultEvent.errors)
    : resultEvent.subtype ?? "unknown error";
  log.error(
    `claude returned non-success subtype "${resultEvent.subtype}":`,
    JSON.stringify(resultEvent),
  );
  throw new Error(`claude returned error: ${errors}`);
}

/**
 * Claude Code CLI をストリーミングモードで呼び出し、
 * テキストを文単位で逐次 yield する。
 *
 * stream_event の text_delta を蓄積し、文境界（。、改行）を検出したら
 * その文を即座に yield する。呼び出し側は受け取った文を逐次 TTS に
 * 渡すことで、応答全体の完了を待たずに音声再生を開始できる。
 *
 * サブエージェント（parent_tool_use_id !== null）のテキストは除外する。
 *
 * @param prompt - ユーザーの発話テキスト。
 * @param options - Claude CLI オプション。
 * @yields テキストチャンク（文単位）と終了イベント。
 * @throws 結果イベントが無い場合、またはエラーイベントの場合。
 */
export async function* streamClaudeForVoice(
  prompt: string,
  options: ClaudeCallOptions & {
    config: ClaudeConfig;
    signal?: AbortSignal;
    spawner?: CommandSpawner;
  },
): AsyncGenerator<VoiceStreamEvent> {
  const stream = askClaude(prompt, options);
  let buffer = "";
  let sessionId = "";
  let hasResult = false;
  let hasStreamedText = false;
  let resultText = "";

  for await (const event of stream) {
    // ストリーミングテキストチャンクの処理。
    // parent_tool_use_id が falsy（null / undefined / 未設定）ならトップレベル。
    if (
      event.type === "stream_event" &&
      !event.parent_tool_use_id
    ) {
      const e = event.event;
      if (
        e.type === "content_block_delta" &&
        "text" in e.delta &&
        e.delta.type === "text_delta"
      ) {
        buffer += e.delta.text;
        // 文境界（。、改行）で分割し、完成した文を即座に yield。
        const parts = buffer.split(/(?<=[。\n])/);
        if (parts.length > 1) {
          for (let i = 0; i < parts.length - 1; i++) {
            const s = parts[i].trim();
            if (s) {
              hasStreamedText = true;
              log.debug(`streaming chunk: "${s}"`);
              yield { type: "text", text: s };
            }
          }
          buffer = parts[parts.length - 1];
        }
      }
    }

    // result イベントからセッション ID とテキストを取得。
    if (event.type === "result") {
      hasResult = true;

      // deno-lint-ignore no-explicit-any
      const r = event as any;

      // result フィールドがあればテキストとして採用する。
      // error_max_turns 等でも result が含まれていればそれを使う
      // （元の askClaudeForVoice と同じ挙動）。
      if (typeof r.result === "string") {
        sessionId = event.session_id;
        if (event.subtype !== "success") {
          // result はあるが non-success: streaming は使うがログには警告を残す。
          log.warn(
            `claude voice non-success subtype "${event.subtype}":`,
            JSON.stringify(event),
          );
        }
        resultText = r.result;
      } else {
        const errorDetail = r.errors
          ? JSON.stringify(r.errors)
          : r.subtype ?? "unknown error";
        log.error(
          `claude voice returned non-success subtype "${r.subtype}":`,
          JSON.stringify(event),
        );
        throw new Error(`claude returned error: ${errorDetail}`);
      }
    }
  }

  // バッファに残ったストリーミングテキストを flush。
  const remaining = buffer.trim();
  if (remaining) {
    hasStreamedText = true;
    log.debug(`streaming final chunk: "${remaining}"`);
    yield { type: "text", text: remaining };
  }

  // hasStreamedText が true の場合、error_max_turns 等でも
  // ストリーム済みテキストをそのまま使用する（resultText は無視）。
  // ストリーミング中に yield 済みのテキストと resultText は同一内容のため、
  // 二重に yield する必要はない。
  //
  // stream_event が出力されなかった場合、result.result からテキストを抽出する。
  if (!hasStreamedText && resultText) {
    log.info("no stream_event received, falling back to result text");
    const sentences = resultText
      .split(/(?<=[。\n])/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const s of sentences) {
      yield { type: "text", text: s };
    }
  }

  if (!hasResult) {
    throw new Error("claude stream ended without result event");
  }

  log.info(
    `voice stream completed (streamed=${hasStreamedText}, ` +
      `resultLen=${resultText.length})`,
  );
  yield { type: "end", sessionId };
}
