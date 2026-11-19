/**
 * 会話の中核。
 *
 * 「scope 単位の直列キュー → セッション・設定の取得 → システムプロンプト解決 →
 * `askClaude()` → ストリーム消費」を担う。discord.js を含む特定の client に
 * 依存せず、client は {@link TurnOutput} を実装して {@link Conversation.submit}
 * を呼ぶ (依存は client → core の一方向。`.oxlintrc.json` で検査している)。
 *
 * @module
 */

import type {
  CanUseTool,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  askClaude,
  drainResultEvent,
  extractTopLevelTextDelta,
  extractTopLevelThinkingDelta,
  handleResultEvent,
  type ClaudeCallOptions,
  type QueryFn,
  requireResultText,
} from "../claude/mod.ts";
import type { SystemPromptStore } from "../claude/system-prompt.ts";
import type { ClaudeConfig } from "../config.ts";
import { createLogger } from "../logger.ts";
import type { Store, StoreScope } from "../store/mod.ts";
import { splitAtBoundary } from "./flush.ts";
import { ScopeQueue } from "./queue.ts";
import type { SelfMentionRateLimiter } from "./ratelimit.ts";

// bot/mod.ts から切り出す前と同じ namespace を使い、ログの出力形を変えない。
const log = createLogger("bot");

/** 回答テキストを文境界でフラッシュし始める閾値 (文字数)。 */
export const FLUSH_THRESHOLD = 800;

/**
 * thinking を文境界でフラッシュし始める閾値 (文字数)。
 * 回答より高めにして、推論の中間投稿で本文が埋もれないようにする。
 */
export const THINKING_FLUSH_THRESHOLD = 1500;

/**
 * AI to AI 自己メンションで起動したターンのプロンプト先頭に付ける注記。
 * 発話者のテンプレート変数は認可ユーザーに差し替えるため、この注記が無いと
 * モデルは人間の発話と区別できない。
 */
export const SELF_MENTION_PROMPT_NOTE =
  "[AI to AI 自己メンション] この依頼は認可ユーザー本人の発話ではなく、別のチャンネル/スレッドで動いている自 bot のセッションが投稿したもの。";

/** 1 ターン分の入力。 */
export interface TurnInput {
  /** 永続化スコープ (セッション・設定の引き先)。 */
  scope: StoreScope;
  /** 直列化の単位 (スレッドならスレッド ID、そうでなければチャンネル ID)。 */
  localId: string;
  /** ユーザーの依頼本文。 */
  prompt: string;
  /** 自 bot の投稿 (AI to AI 自己メンション) による起動か。 */
  isSelfMessage: boolean;
  /** システムプロンプトのテンプレート変数。client が組み立てる。 */
  templateVars: Record<string, string>;
}

/**
 * 1 ターンの出力先。中核が定義し、client が実装する。
 *
 * メソッドの呼び出し順は `onQueued` (busy 時のみ・submit 内) →
 * `onTurnStart` → `preparePrompt` → (`sendReply` / `sendThinking` /
 * `reportProgress` / `notifyError`) → `onTurnEnd`。`onTurnStart` の失敗を含め、
 * ターンの成否に関わらず `onTurnEnd` が必ず呼ばれる。
 */
export interface TurnOutput {
  /**
   * 同一 scope のターンが実行中で、このターンがキュー待ちに入るときに呼ぶ。
   * 同期 (戻り値を await しない)。待機の可視化用で、失敗は client 側で握り潰す。
   */
  onQueued(): void;
  /** このターンが始まったときに呼ぶ (待機表示の解除・入力中表示の開始等)。 */
  onTurnStart(): Promise<void>;
  /**
   * プロンプトを加工する (添付の取り込み等)。空文字列または `undefined` を
   * 返すとターンを何もせず終える。
   */
  preparePrompt(prompt: string): Promise<string | undefined>;
  /** 回答テキストを送る。分割・宛先の前置は client が行う。 */
  sendReply(text: string): Promise<void>;
  /** thinking (推論) を送る。 */
  sendThinking(text: string): Promise<void>;
  /** ツール実行の進捗を報告する。 */
  reportProgress(toolName: string, elapsedSeconds: number): Promise<void>;
  /** ターンの失敗を通知する (要約の生成は client が行う)。失敗は握り潰される。 */
  notifyError(error: unknown): Promise<void>;
  /** ターンの後始末。成否に関わらず最後に 1 回呼ぶ。 */
  onTurnEnd(): Promise<void>;
}

/** {@link Conversation} の依存。 */
export interface ConversationDeps {
  store: Pick<
    Store,
    "getSession" | "setSession" | "getModel" | "getEffort" | "getShowThinking"
  >;
  systemPrompts: Pick<SystemPromptStore, "resolve">;
  claudeConfig: ClaudeConfig;
  /** `query()` の env へ追加で注入する環境変数。 */
  env?: Record<string, string>;
  /** ツール承認コールバックの生成。`localId` は承認の送り先の識別子。 */
  createCanUseTool: (localId: string, signal: AbortSignal) => CanUseTool;
  selfMentionLimiter: Pick<
    SelfMentionRateLimiter,
    "tryConsume" | "isExhausted"
  >;
  queryFn?: QueryFn;
}

/**
 * 会話の中核。scope 単位でターンを直列化し、1 ターンを実行する。
 */
export class Conversation {
  /** scope (channel / thread) 単位でターンを直列化するキュー。 */
  private readonly chatQueue = new ScopeQueue();
  private readonly deps: ConversationDeps;

  constructor(deps: ConversationDeps) {
    this.deps = deps;
  }

  /** 自己メンション応答のレート枠が尽きているか (消費しない)。 */
  isSelfMentionExhausted(): boolean {
    return this.deps.selfMentionLimiter.isExhausted();
  }

  /**
   * 1 ターンを投入し、ターンの完了 (キュー待ちを含む) まで待つ。
   *
   * bot が応答中の scope に届いた入力は直列キューに積み、現在のターンが
   * 終わってから同一セッションで処理する (Claude Code が応答生成中の入力を
   * キューに積み、ターン終了後に処理するのと同じ挙動)。これにより同一 scope
   * への並行 query を防ぎ、session_id の競合を構造的に無くす。
   */
  async submit(input: TurnInput, output: TurnOutput): Promise<void> {
    // isBusy 判定と enqueue 登録の間に await を挟まないこと。挟むと連投時に後続
    // メッセージの enqueue が先に登録されて順序が入れ替わりうる。onQueued は
    // fire-and-forget にして await しない。
    const wasQueued = this.chatQueue.isBusy(input.localId);
    if (wasQueued) {
      output.onQueued();
    }

    await this.chatQueue.enqueue(input.localId, () =>
      this.runTurn(input, output),
    );
  }

  private async runTurn(input: TurnInput, output: TurnOutput): Promise<void> {
    const { scope, localId, isSelfMessage, templateVars } = input;
    const { store, systemPrompts, claudeConfig } = this.deps;

    try {
      await output.onTurnStart();

      // 添付の取り込み等 (client 側のプロンプト加工)。
      let prompt = await output.preparePrompt(input.prompt);

      // 加工後もプロンプトが空なら終了
      if (!prompt) {
        return;
      }

      // 自己メンション応答のレート枠は、実際に query を実行する直前にのみ消費する
      // (空プロンプト等で応答しないメッセージに枠を浪費しない)。
      if (isSelfMessage && !this.deps.selfMentionLimiter.tryConsume()) {
        log.warn(
          `self-mention rate limit exceeded, ignoring message in ${localId}`,
        );
        return;
      }

      // 自己起動ターンでは、この依頼が人間の発話ではなく別スコープの自 bot
      // セッションからのものだとモデルに伝える (発話者変数は本人に差し替える
      // ため、これが無いと人間の発話と区別できない)。
      if (isSelfMessage) {
        prompt = `${SELF_MENTION_PROMPT_NOTE}\n\n${prompt}`;
      }

      const [sessionId, model, effort, showThinking] = await Promise.all([
        store.getSession(scope),
        store.getModel(scope),
        store.getEffort(scope),
        store.getShowThinking(scope),
      ]);

      const appendSystemPrompt = systemPrompts.resolve(
        "chat",
        scope,
        templateVars,
      );

      const signal = AbortSignal.timeout(claudeConfig.timeout);
      const stream = askClaude(prompt, {
        sessionId,
        config: claudeConfig,
        env: this.deps.env,
        signal,
        appendSystemPrompt,
        model,
        effort,
        canUseTool: this.deps.createCanUseTool(localId, signal),
        queryFn: this.deps.queryFn,
      });

      // ストリーミング応答: text_delta をバッファに蓄積し、
      // 閾値を超えたら文境界で区切って中間投稿する。
      // 分割アルゴリズム自体は splitAtBoundary (core/flush.ts) に切り出してある。
      let textBuffer = "";
      let hasStreamedText = false;
      let resultEvent: SDKResultMessage | undefined;

      const flushBuffer = async (force: boolean) => {
        const result = splitAtBoundary(textBuffer, FLUSH_THRESHOLD, force);
        if (!result) {
          return;
        }
        textBuffer = result.rest;
        if (result.send) {
          hasStreamedText = true;
          await output.sendReply(result.send);
        }
      };

      // thinking 用バッファ。回答テキストとは独立に文境界でフラッシュする。
      let thinkingBuffer = "";

      const flushThinking = async (force: boolean) => {
        const result = splitAtBoundary(
          thinkingBuffer,
          THINKING_FLUSH_THRESHOLD,
          force,
        );
        if (!result) {
          return;
        }
        thinkingBuffer = result.rest;
        if (result.send) {
          await output.sendThinking(result.send);
        }
      };

      for await (const event of stream) {
        const delta = extractTopLevelTextDelta(event);
        const thinkingDelta = showThinking
          ? extractTopLevelThinkingDelta(event)
          : undefined;
        if (delta !== undefined) {
          // 回答テキストが来たら、未送出の thinking を先に出して順序を保つ。
          if (thinkingBuffer) {
            await flushThinking(true);
          }
          textBuffer += delta;
          if (textBuffer.length >= FLUSH_THRESHOLD) {
            await flushBuffer(false);
          }
        } else if (thinkingDelta !== undefined) {
          thinkingBuffer += thinkingDelta;
          if (thinkingBuffer.length >= THINKING_FLUSH_THRESHOLD) {
            await flushThinking(false);
          }
        } else if (event.type === "assistant" && !event.parent_tool_use_id) {
          // トップレベルの assistant メッセージ 1 件が完成した時点で強制フラッシュ。
          // Claude が「テキスト → ツール実行 → テキスト」と複数の応答に分かれて
          // 喋る場合、各応答を別々の投稿として区切るため。閾値による
          // 途中フラッシュ (上の delta 分岐) は応答内のストリーミング体感のために残す。
          await flushThinking(true);
          await flushBuffer(true);
        } else if (event.type === "result") {
          resultEvent = event;
          // 非 success の subtype (error_max_turns 等) は Docker logs から原因を追えるよう詳細を残す。
          // 非ゼロ終了でジェネレータがスローしてもセッションが残るよう即座に保存する。
          await handleResultEvent(event, {
            onNonSuccess: (event) =>
              log.warn(
                `claude returned non-success subtype "${event.subtype}":`,
                JSON.stringify(event),
              ),
            setSession: (sessionId) => store.setSession(scope, sessionId),
          });
        } else if (event.type === "tool_progress") {
          await output.reportProgress(
            event.tool_name,
            event.elapsed_time_seconds,
          );
        }
      }

      // バッファに残った thinking / テキストを投稿。
      await flushThinking(true);
      await flushBuffer(true);

      // stream_event がなかった場合は result.result からフォールバック。
      if (!hasStreamedText) {
        const text = requireResultText(resultEvent);
        await output.sendReply(text);
      }
    } catch (error: unknown) {
      // logger は Error の stack を自動で展開する。全文はここに残す。
      log.error("failed to process message:", error);
      // 通知には要約のみ送り、全文は上記ログ (GET /logs) を参照させる。
      await output.notifyError(error).catch(() => {});
    } finally {
      await output.onTurnEnd();
    }
  }
}

/**
 * {@link runOneShot} のオプション。
 *
 * `askClaude()` に渡す {@link ClaudeCallOptions} は継承し、フィールドの追加が
 * cron 側で取りこぼされないようにする。
 */
export interface OneShotOptions extends ClaudeCallOptions {
  prompt: string;
  /** 実行設定 (呼び出し側で `maxTurns` 等の上書きを済ませたもの)。 */
  config: ClaudeConfig;
  /** result イベントのたびにセッション ID を保存する。省略時は保存しない。 */
  setSession?: (sessionId: string) => Promise<void>;
  signal?: AbortSignal;
  /** 非 success の result イベントを受けたときの処理 (ログ等)。 */
  onNonSuccess: (event: SDKResultMessage) => void;
  queryFn?: QueryFn;
}

/**
 * ストリーミングも `ScopeQueue` も通さず、1 回の依頼を実行して結果テキストを返す。
 *
 * result イベントが無い/エラーのときは `requireResultText()` の例外がそのまま
 * 伝わる。結果の送出先 (投稿の有無) に関わらず常に評価される。
 */
export async function runOneShot(options: OneShotOptions): Promise<string> {
  const { prompt, setSession, onNonSuccess, ...askOptions } = options;
  const stream: AsyncIterable<SDKMessage> = askClaude(prompt, askOptions);

  const resultEvent = await drainResultEvent(stream, {
    onNonSuccess,
    setSession,
  });

  return requireResultText(resultEvent);
}
