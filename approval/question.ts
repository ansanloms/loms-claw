/**
 * Discord select menu による AskUserQuestion 回答マネージャー。
 *
 * Agent SDK の AskUserQuestion ツールは `canUseTool` コールバックに
 * `toolName === "AskUserQuestion"` として流れてくる。質問 (1〜4 件) を
 * Discord の StringSelectMenu で提示し、ユーザーの回答を収集して
 * `updatedInput.answers` (質問文 → 選択ラベル) として返すための部品。
 *
 * 各質問の選択肢には自動で「Other (自由入力)」を追加し、選択時は
 * Modal (テキスト入力) で自由記述を受け付ける。
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type Client,
  type GuildTextBasedChannel,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { createLogger } from "../logger.ts";
import { getErrorMessage } from "../errors.ts";

const log = createLogger("question");

/**
 * 回答タイムアウト（ミリ秒）。承認 (ApprovalManager) と同じ 5 分。
 */
const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 「Other (自由入力)」選択肢の select value。
 */
export const OTHER_VALUE = "__other__";

/**
 * AskUserQuestion の 1 質問。SDK の `AskUserQuestionInput` の 1 要素に対応する。
 *
 * SDK 側の型は 1〜4 件の固定長タプルの合併で扱いづらいため、実行時検証
 * ({@link parseQuestions}) を単一ソースにローカルで定義する。
 */
export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

/**
 * 質問の選択肢。
 */
export interface QuestionOption {
  label: string;
  description: string;
}

/**
 * 回答収集の結果。
 *
 * `answered` の `answers` は質問文 → 回答文字列 (multiSelect は ", " 連結)。
 * SDK の `updatedInput.answers` にそのまま載せる形。
 */
export type QuestionResult =
  | { kind: "answered"; answers: Record<string, string> }
  | { kind: "denied"; reason: string };

/**
 * Discord の component 数上限に由来する質問数の上限。
 *
 * 1 メッセージの action row は最大 5。質問ごとに select 1 行 + Cancel
 * ボタン 1 行で、質問は最大 4 件 (SDK スキーマの上限とも一致する)。
 */
const MAX_QUESTIONS = 4;

/**
 * 1 つの select に載せられる選択肢の上限 (Discord 上限 25 - Other 1 件)。
 */
const MAX_OPTIONS = 24;

/**
 * unknown 値がプレーンなオブジェクト (Record) であるか判定する type guard。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * `canUseTool` が受け取った AskUserQuestion の入力から質問一覧を取り出す。
 *
 * 構造が不正な場合 (questions が配列でない、件数が 0 または 5 以上、
 * 選択肢が欠落している等) は `undefined` を返す。`multiSelect` の欠落は
 * `false` 扱いにする。
 */
export function parseQuestions(
  input: Record<string, unknown>,
): Question[] | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions)) {
    return undefined;
  }
  if (questions.length < 1 || questions.length > MAX_QUESTIONS) {
    return undefined;
  }

  const parsed: Question[] = [];
  for (const record of questions) {
    if (!isRecord(record)) {
      return undefined;
    }
    if (
      typeof record.question !== "string" ||
      typeof record.header !== "string" ||
      !Array.isArray(record.options) ||
      record.options.length < 1
    ) {
      return undefined;
    }
    const options: QuestionOption[] = [];
    for (const opt of record.options.slice(0, MAX_OPTIONS)) {
      if (!isRecord(opt)) {
        return undefined;
      }
      if (typeof opt.label !== "string" || opt.label.length === 0) {
        return undefined;
      }
      options.push({
        label: opt.label,
        description: typeof opt.description === "string" ? opt.description : "",
      });
    }
    parsed.push({
      question: record.question,
      header: record.header,
      options,
      multiSelect: record.multiSelect === true,
    });
  }
  return parsed;
}

/**
 * select の values (選択肢 index の文字列 / {@link OTHER_VALUE}) を
 * 選択肢ラベルに解決する。
 *
 * 不明な value は無視する。`hasOther` は Other が含まれていたかを示す。
 */
export function resolveSelectedLabels(
  question: Question,
  values: string[],
): { labels: string[]; hasOther: boolean } {
  const labels: string[] = [];
  let hasOther = false;
  for (const value of values) {
    if (value === OTHER_VALUE) {
      hasOther = true;
      continue;
    }
    const index = Number(value);
    const option = question.options[index];
    if (option) {
      labels.push(option.label);
    }
  }
  return { labels, hasOther };
}

/**
 * 選択ラベル群を SDK の answers 値 (1 文字列) に組み立てる。
 * multiSelect の回答は ", " 連結 (SDK の AskUserQuestionOutput の仕様に合わせる)。
 */
export function formatAnswer(labels: string[]): string {
  return labels.join(", ");
}

/**
 * Discord の文字数上限に合わせて文字列を切り詰める。
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return text.slice(0, max - 1) + "…";
}

/**
 * 収集中の質問セットの状態。
 */
interface PendingQuestions {
  questions: Question[];
  /** 質問 index → 確定した回答文字列。 */
  answers: Map<number, string>;
  /** Other 選択時、Modal 入力待ちの間に併選択されたラベルを保持する。 */
  pendingOther: Map<number, string[]>;
  resolve: (result: QuestionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * AskUserQuestion 回答マネージャー。
 *
 * 質問メッセージの送信、select / Modal / Cancel ボタンのインタラクション
 * 処理、回答の収集を担う。channel の解決 (fallback 含む) は呼び出し側
 * (ApprovalManager) の責務とし、ここでは受け取った channelId を使うだけ。
 */
export class QuestionManager {
  private pending = new Map<string, PendingQuestions>();

  constructor(private client: Client) {}

  /**
   * 質問を Discord に送信し、全質問への回答が揃うまで待つ。
   *
   * Cancel ボタン押下・タイムアウト・チャンネル解決失敗は `denied` を返す。
   */
  async requestAnswers(
    questions: Question[],
    channelId?: string,
  ): Promise<QuestionResult> {
    if (!channelId) {
      log.warn("no channel set for questions, denying");
      return { kind: "denied", reason: "No channel to ask the user" };
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      log.warn("question channel not found:", channelId);
      return { kind: "denied", reason: "Channel not found" };
    }

    const requestId = crypto.randomUUID().slice(0, 8);

    const contentLines = [
      "**Claude からの質問**",
      ...questions.map((q, i) => `**${i + 1}. ${q.header}** — ${q.question}`),
    ];
    const content = truncate(contentLines.join("\n"), 2000);

    const message = await (channel as GuildTextBasedChannel).send({
      content,
      components: this.buildComponents(requestId, questions, new Map()),
    });

    log.info(
      "questions requested:",
      requestId,
      `${questions.length} question(s)`,
    );

    return new Promise<QuestionResult>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        log.warn("questions timed out:", requestId);
        message.edit({
          content: truncate(message.content + "\n**→ Timed out**", 2000),
          components: [],
        }).catch((error: unknown) => {
          log.warn("failed to edit timed out message:", getErrorMessage(error));
        });
        resolve({ kind: "denied", reason: "Timed out" });
      }, ANSWER_TIMEOUT_MS);

      this.pending.set(requestId, {
        questions,
        answers: new Map(),
        pendingOther: new Map(),
        resolve,
        timeout,
      });
    });
  }

  /**
   * select メニューのインタラクションを処理する。
   *
   * 対象外の customId なら `false` を返す (他のハンドラへ回す)。
   */
  async handleSelect(
    interaction: StringSelectMenuInteraction,
  ): Promise<boolean> {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "question") {
      return false;
    }
    const requestId = parts[1];
    const index = Number(parts[2]);

    const pending = this.pending.get(requestId);
    if (!pending) {
      await this.replyExpired(interaction);
      return true;
    }
    const question = pending.questions[index];
    if (!question) {
      return true;
    }

    const { labels, hasOther } = resolveSelectedLabels(
      question,
      interaction.values,
    );

    if (hasOther) {
      // Modal を開いて自由記述を待つ。回答の確定は handleModal で行う。
      pending.pendingOther.set(index, labels);
      await interaction.showModal(
        this.buildOtherModal(requestId, index, question),
      );
      return true;
    }

    pending.answers.set(index, formatAnswer(labels));
    await this.applyProgress(interaction, requestId, pending);
    return true;
  }

  /**
   * Other (自由入力) Modal の送信を処理する。
   *
   * 対象外の customId なら `false` を返す。
   */
  async handleModal(interaction: ModalSubmitInteraction): Promise<boolean> {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "question-other") {
      return false;
    }
    const requestId = parts[1];
    const index = Number(parts[2]);

    const pending = this.pending.get(requestId);
    if (!pending) {
      await this.replyExpired(interaction);
      return true;
    }
    if (!pending.questions[index]) {
      return true;
    }

    const text = interaction.fields.getTextInputValue("text").trim();
    const labels = pending.pendingOther.get(index) ?? [];
    pending.pendingOther.delete(index);
    const combined = text ? [...labels, text] : labels;
    pending.answers.set(
      index,
      formatAnswer(combined.length > 0 ? combined : ["(no answer)"]),
    );

    if (interaction.isFromMessage()) {
      await this.applyProgress(interaction, requestId, pending);
    }
    return true;
  }

  /**
   * Cancel ボタンのインタラクションを処理する。
   *
   * 対象外の customId なら `false` を返す。
   */
  async handleButton(interaction: ButtonInteraction): Promise<boolean> {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "question-cancel") {
      return false;
    }
    const requestId = parts[1];

    const pending = this.pending.get(requestId);
    if (!pending) {
      await this.replyExpired(interaction);
      return true;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve({ kind: "denied", reason: "Cancelled by user" });

    await interaction.update({
      content: interaction.message.content + "\n**→ Cancelled**",
      components: [],
    });

    log.info("questions cancelled:", requestId);
    return true;
  }

  /**
   * 回答の進捗をメッセージへ反映し、全問回答済みなら resolve する。
   */
  private async applyProgress(
    interaction:
      | StringSelectMenuInteraction
      | ModalMessageModalSubmitInteraction,
    requestId: string,
    pending: PendingQuestions,
  ): Promise<void> {
    if (pending.answers.size < pending.questions.length) {
      await interaction.update({
        components: this.buildComponents(
          requestId,
          pending.questions,
          pending.answers,
        ),
      });
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);

    const answers: Record<string, string> = {};
    pending.questions.forEach((q, i) => {
      answers[q.question] = pending.answers.get(i) ?? "";
    });
    pending.resolve({ kind: "answered", answers });

    const summary = pending.questions
      .map((q, i) => `**${q.header}**: ${pending.answers.get(i) ?? ""}`)
      .join("\n");
    await interaction.update({
      content: truncate(
        interaction.message.content + "\n**→ 回答済み**\n" + summary,
        2000,
      ),
      components: [],
    });

    log.info("questions answered:", requestId);
  }

  /**
   * 質問セットから action row 群 (select × 質問数 + Cancel ボタン) を構築する。
   *
   * 回答済みの質問の select は disabled にし、placeholder に回答を表示する。
   */
  private buildComponents(
    requestId: string,
    questions: Question[],
    answers: Map<number, string>,
  ): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] {
    const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] =
      questions.map((q, i) => {
        const answered = answers.get(i);
        const select = new StringSelectMenuBuilder()
          .setCustomId(`question:${requestId}:${i}`)
          .setPlaceholder(
            truncate(
              answered !== undefined
                ? `${i + 1}. ${answered}`
                : `${i + 1}. ${q.question}`,
              150,
            ),
          )
          .setDisabled(answered !== undefined)
          .setMinValues(1)
          .setMaxValues(q.multiSelect ? q.options.length + 1 : 1)
          .addOptions(
            ...q.options.map((o, j) => ({
              label: truncate(o.label, 100),
              value: String(j),
              ...(o.description
                ? { description: truncate(o.description, 100) }
                : {}),
            })),
            {
              label: "Other (自由入力)",
              value: OTHER_VALUE,
              description: "選択肢に無い回答をテキストで入力する",
            },
          );
        return new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>()
          .addComponents(select);
      });

    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`question-cancel:${requestId}`)
            .setLabel("Cancel")
            .setStyle(ButtonStyle.Danger),
        ),
    );

    return rows;
  }

  /**
   * Other (自由入力) 用の Modal を構築する。
   */
  private buildOtherModal(
    requestId: string,
    index: number,
    question: Question,
  ): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`question-other:${requestId}:${index}`)
      .setTitle(truncate(question.header, 45))
      .addLabelComponents(
        new LabelBuilder()
          .setLabel(truncate(question.question, 45))
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId("text")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setMaxLength(1000),
          ),
      );
  }

  /**
   * 期限切れ・処理済みのインタラクションに ephemeral で応答する。
   */
  private async replyExpired(
    interaction:
      | StringSelectMenuInteraction
      | ModalSubmitInteraction
      | ButtonInteraction,
  ): Promise<void> {
    try {
      await interaction.reply({
        content: "この質問は期限切れか、既に処理済みです。",
        flags: MessageFlags.Ephemeral,
      });
    } catch (error: unknown) {
      log.warn("failed to reply expired:", getErrorMessage(error));
    }
  }
}
