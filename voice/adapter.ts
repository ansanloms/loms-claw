/**
 * Claude Code CLI と音声パイプラインのアダプタ。
 *
 * askClaude() が返す SDKMessage ストリームから結果テキストを抽出し、
 * 音声パイプラインが消費しやすい形で返す。
 */

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { askClaude, type CommandSpawner } from "../claude/mod.ts";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("voice-adapter");

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
  options: {
    sessionId?: string;
    config: ClaudeConfig;
    signal?: AbortSignal;
    spawner?: CommandSpawner;
    appendSystemPrompt?: string;
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
  throw new Error(`claude returned error: ${errors}`);
}
