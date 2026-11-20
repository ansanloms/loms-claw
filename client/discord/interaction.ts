/**
 * interaction (ボタン / select / modal / スラッシュコマンド) の認可と振り分け。
 *
 * 全種別を先頭で `isAuthorized()` に通し、通過したものだけを各ハンドラへ渡す。
 * 承認 UI のボタン等は承認メッセージが見えるギルドメンバー全員が押せるため、
 * ハンドラ側ではなくここで弾く。
 */

import {
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  MessageFlags,
  type ModalSubmitInteraction,
  type RepliableInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import type { Config } from "../../config.ts";
import { getErrorMessage } from "../../errors.ts";
import { createLogger } from "../../logger.ts";
import { isAuthorized } from "./guard.ts";

const log = createLogger("interaction");

/** 認可されない interaction への拒否文言。 */
const UNAUTHORIZED_MESSAGE = "この操作は許可されていません。";

/**
 * `dispatchInteraction()` が必要とする依存。
 */
export interface InteractionDeps {
  config: Config;
  approvalManager: {
    handleButton(interaction: ButtonInteraction): Promise<unknown>;
    handleSelect(interaction: StringSelectMenuInteraction): Promise<unknown>;
    handleModal(interaction: ModalSubmitInteraction): Promise<unknown>;
  };
  handleCommand(interaction: ChatInputCommandInteraction): Promise<unknown>;
}

/**
 * インタラクションのハンドラを実行し、失敗時にログとエフェメラル返信で揃える。
 *
 * button / select メニュー / Modal 送信 / スラッシュコマンドの 4 ハンドラが同形の
 * `try { handler } catch { log.error; if (!replied && !deferred) reply(ephemeral) }`
 * を持っていたため、ここに集約する。ログ文言・エラー返信文言は呼び出し側から渡す。
 */
async function runInteraction(
  interaction: RepliableInteraction,
  label: string,
  handler: () => Promise<unknown>,
  errorMessage: string,
): Promise<void> {
  try {
    await handler();
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    log.error(`${label} interaction error:`, msg);
    if (!interaction.replied && !interaction.deferred) {
      await interaction
        .reply({
          content: errorMessage,
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => {});
    }
  }
}

/** ログ用の interaction 種別。 */
function interactionKind(interaction: Interaction): string {
  if (interaction.isButton()) {
    return "button";
  }
  if (interaction.isStringSelectMenu()) {
    return "select";
  }
  if (interaction.isModalSubmit()) {
    return "modal";
  }
  if (interaction.isChatInputCommand()) {
    return "chat-input";
  }
  return "other";
}

/** ログ用の customId 表記 (customId を持つ種別のみ)。 */
function customIdOf(interaction: Interaction): string {
  if (
    interaction.isButton() ||
    interaction.isStringSelectMenu() ||
    interaction.isModalSubmit()
  ) {
    return ` customId=${interaction.customId}`;
  }
  return "";
}

/**
 * interaction を認可したうえで種別ごとのハンドラへ振り分ける。
 *
 * 認可されない interaction は、返信可能なら ephemeral で拒否を返し、
 * どのハンドラも呼ばない (承認の pending や settings.json は触れない)。
 */
export async function dispatchInteraction(
  interaction: Interaction,
  deps: InteractionDeps,
): Promise<void> {
  if (
    !isAuthorized(
      interaction.guildId,
      interaction.user.id,
      interaction.user.bot,
      deps.config,
    )
  ) {
    log.info(
      `unauthorized interaction rejected: user=${interaction.user.id} type=${interactionKind(interaction)}${customIdOf(interaction)}`,
    );
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({
          content: UNAUTHORIZED_MESSAGE,
          flags: MessageFlags.Ephemeral,
        });
      } catch (error: unknown) {
        log.warn(
          "failed to reply unauthorized interaction:",
          getErrorMessage(error),
        );
      }
    }
    return;
  }

  // ボタンインタラクション（承認/拒否、質問の Cancel）
  if (interaction.isButton()) {
    await runInteraction(
      interaction,
      "button",
      () => deps.approvalManager.handleButton(interaction),
      "承認処理中にエラーが発生しました。",
    );
    return;
  }

  // select メニュー（AskUserQuestion の回答）
  if (interaction.isStringSelectMenu()) {
    await runInteraction(
      interaction,
      "select",
      () => deps.approvalManager.handleSelect(interaction),
      "回答処理中にエラーが発生しました。",
    );
    return;
  }

  // Modal 送信（AskUserQuestion の Other 自由入力）
  if (interaction.isModalSubmit()) {
    await runInteraction(
      interaction,
      "modal",
      () => deps.approvalManager.handleModal(interaction),
      "回答処理中にエラーが発生しました。",
    );
    return;
  }

  if (interaction.isChatInputCommand()) {
    await runInteraction(
      interaction,
      "chat-input",
      () => deps.handleCommand(interaction),
      "コマンド処理中にエラーが発生しました。",
    );
  }
}
