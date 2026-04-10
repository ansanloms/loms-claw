/**
 * 音声認識（Speech-to-Text）。
 *
 * SpeechToText インターフェースと、whisper.cpp HTTP サーバーによる実装を提供する。
 *
 * @see https://github.com/ggml-org/whisper.cpp — サーバーモードのドキュメント
 */

import { Buffer } from "node:buffer";
import { createLogger } from "../logger.ts";
import { pcmToWav } from "./codec.ts";

const log = createLogger("stt");

/**
 * Discord から取得した生 PCM 音声をテキストに変換する。
 */
export interface SpeechToText {
  /**
   * 指定された PCM 音声バッファを文字起こしする。
   *
   * @param pcm - 48 kHz モノラル 16 ビットの生 PCM 音声。
   * @returns 文字起こし結果。認識できなかった場合は空文字列。
   */
  transcribe(pcm: Buffer): Promise<string>;
}

/**
 * whisper.cpp が出力する非音声プレースホルダトークンにマッチする正規表現。
 * モデルが無音や非言語音声を検出した場合に出現する。
 */
const NON_SPEECH_PATTERNS = [
  /\[.*?\]/g, // 例: [音声なし], [BLANK_AUDIO]
  /\(.*?\)/g, // 例: (音声なし), (無音)
  /\*.*?\*/g, // 例: *音声なし*
];

/**
 * WhisperStt のコンストラクタ設定。
 */
export interface WhisperSttConfig {
  /**
   * whisper.cpp サーバーのベース URL（例: `http://localhost:8178`）。
   */
  baseUrl: string;

  /**
   * no_speech_prob の閾値。
   * verbose_json 形式で返却される各セグメントの no_speech_prob が
   * 全セグメントでこの値以上の場合、音声なしと判定する。
   */
  noSpeechProbThreshold: number;
}

/**
 * whisper.cpp の OpenAI 互換推論サーバーを使った音声認識。
 *
 * PCM 音声を WAV に変換し、`/inference` に POST する。
 * 結果から非音声プレースホルダトークンを除去して返す。
 */
export class WhisperStt implements SpeechToText {
  private readonly baseUrl: string;
  private readonly noSpeechProbThreshold: number;

  constructor(config: WhisperSttConfig) {
    this.baseUrl = config.baseUrl;
    this.noSpeechProbThreshold = config.noSpeechProbThreshold;
  }

  /**
   * @inheritdoc
   */
  async transcribe(pcm: Buffer): Promise<string> {
    const wav = pcmToWav(pcm);
    const form = new FormData();
    // Blob は ArrayBufferView<ArrayBuffer> を要求する。
    // Buffer の buffer プロパティは ArrayBufferLike なので明示キャストする。
    const wavBytes = new Uint8Array(
      wav.buffer as ArrayBuffer,
      wav.byteOffset,
      wav.byteLength,
    );
    form.append(
      "file",
      new Blob([wavBytes], { type: "audio/wav" }),
      "audio.wav",
    );
    form.append("response_format", "verbose_json");
    form.append("suppress_non_speech_tokens", "true");

    const res = await fetch(`${this.baseUrl}/inference`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      log.error("whisper error:", res.status, await res.text());
      return "";
    }

    const data = await res.json();

    // 全セグメントの no_speech_prob が閾値以上なら無音と判定する。
    const segments: { no_speech_prob?: number }[] = data.segments ?? [];
    if (
      segments.length > 0 &&
      segments.every((s) =>
        (s.no_speech_prob ?? 0) >= this.noSpeechProbThreshold
      )
    ) {
      log.debug(
        "all segments exceeded no_speech_prob threshold:",
        segments.map((s) => s.no_speech_prob),
      );
      return "";
    }

    const raw: string = (data.text ?? "").trim();

    // 非音声トークンを除去してクリーンな文字起こし結果を返す。
    return NON_SPEECH_PATTERNS
      .reduce((text, pattern) => text.replace(pattern, ""), raw)
      .trim();
  }
}
