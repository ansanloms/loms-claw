/**
 * スラッシュコマンドの定義。
 */

import { SlashCommandBuilder } from "discord.js";

export const command = new SlashCommandBuilder()
  .setName("claw")
  .setDescription("loms-claw bot commands")
  .addSubcommand((sub) =>
    sub
      .setName("clear")
      .setDescription("Clear the conversation session for this channel")
  )
  .addSubcommandGroup((group) =>
    group
      .setName("vc")
      .setDescription("Voice channel operations")
      .addSubcommand((sub) =>
        sub
          .setName("join")
          .setDescription("Join the voice channel")
      )
      .addSubcommand((sub) =>
        sub
          .setName("leave")
          .setDescription("Leave the voice channel")
      )
  );
