/**
 * スラッシュコマンドのハンドラ実装。
 *
 * 各関数はインタラクションの応答（reply/deferReply/editReply）まで責任を持つ。
 * bot/mod.ts はディスパッチのみを行い、ここに委譲する。
 */

import {
  ChannelType,
  type ChatInputCommandInteraction,
  MessageFlags,
} from "discord.js";
import type { SessionStore } from "../session/mod.ts";
import type { VoiceManager } from "../voice/mod.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("handlers");

/**
 * /claw clear — 現在のチャンネルのセッションをクリアする。
 */
export async function handleClear(
  interaction: ChatInputCommandInteraction,
  sessions: SessionStore,
): Promise<void> {
  sessions.delete(interaction.channelId);
  await interaction.reply({
    content: "Session cleared.",
    flags: MessageFlags.Ephemeral,
  });
  log.info("session cleared for channel:", interaction.channelId);
}

/**
 * /claw vc join — ユーザーが居る VC に参加する。
 */
export async function handleVcJoin(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
): Promise<void> {
  if (interaction.channel?.type !== ChannelType.GuildVoice) {
    await interaction.reply({
      content: "Please run this from a VC text chat.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  try {
    await voiceManager.join(interaction.channelId);
    await interaction.editReply("Joined VC.");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log.error("failed to join VC:", msg);
    await interaction.editReply(`Failed to join VC: ${msg}`);
  }
}

/**
 * /claw vc leave — 現在の VC から離脱する。
 */
export async function handleVcLeave(
  interaction: ChatInputCommandInteraction,
  voiceManager: VoiceManager,
): Promise<void> {
  const isVoiceChannel = interaction.channel?.type === ChannelType.GuildVoice;
  if (
    !isVoiceChannel ||
    interaction.channelId !== voiceManager.getCurrentChannelId()
  ) {
    await interaction.reply({
      content: "Please run this from the text chat of the VC I'm in.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  voiceManager.leave();
  await interaction.reply("Left VC.");
}
