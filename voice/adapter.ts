/**
 * Claude (Agent SDK) と音声パイプラインのアダプタ。
 *
 * streamClaudeForVoice() は askClaude() の SDKMessage ストリームから
 * text_delta を文単位で逐次 yield し、TTS の体感遅延を最小化する。
 */

import {
  askClaude,
  type ClaudeCallOptions,
  extractTopLevelTextDelta,
  type QueryFn,
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
 * askClaude() をストリーミングモードで呼び出し、
 * テキストを文単位で逐次 yield する。
 *
 * stream_event の text_delta を蓄積し、文境界（。、改行）を検出したら
 * その文を即座に yield する。呼び出し側は受け取った文を逐次 TTS に
 * 渡すことで、応答全体の完了を待たずに音声再生を開始できる。
 *
 * サブエージェント（parent_tool_use_id !== null）のテキストは除外する。
 *
 * @param prompt - ユーザーの発話テキスト。
 * @param options - Claude 呼び出しオプション。
 * @yields テキストチャンク（文単位）と終了イベント。
 * @throws 結果イベントが無い場合、またはエラーイベントの場合。
 */
export async function* streamClaudeForVoice(
  prompt: string,
  options: ClaudeCallOptions & {
    config: ClaudeConfig;
    signal?: AbortSignal;
    queryFn?: QueryFn;
  },
): AsyncGenerator<VoiceStreamEvent> {
  const stream = askClaude(prompt, options);
  let buffer = "";
  let sessionId = "";
  let hasResult = false;
  let hasStreamedText = false;
  let resultText = "";

  for await (const event of stream) {
    // ストリーミングテキストチャンク (トップレベルの text_delta) の処理。
    const delta = extractTopLevelTextDelta(event);
    if (delta !== undefined) {
      buffer += delta;
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

    // result イベントからセッション ID とテキストを取得。
    if (event.type === "result") {
      hasResult = true;
      // subtype を事前に string として控える。
      // 後段で "result" in event ガードを通すと TS が subtype を success に
      // narrow してしまうため、ガード前にローカル変数で逃がす。
      const subtype: string = event.subtype;

      // result フィールドがあればテキストとして採用する。
      // error_max_turns 等でも result が含まれていればそれを使う。
      if ("result" in event && typeof event.result === "string") {
        sessionId = event.session_id;
        if (subtype !== "success") {
          // result はあるが non-success: streaming は使うがログには警告を残す。
          log.warn(
            `claude voice non-success subtype "${subtype}":`,
            JSON.stringify(event),
          );
        }
        resultText = event.result;
      } else {
        const errorDetail = "errors" in event
          ? JSON.stringify(event.errors)
          : subtype;
        log.error(
          `claude voice returned non-success subtype "${subtype}":`,
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
