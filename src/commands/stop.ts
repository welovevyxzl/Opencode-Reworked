import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { stopCurrentJob, getCurrentJob } from "../opencode/engine.js";
import { baseEmbed, errorEmbed } from "../discord/ui.js";
import { Colors } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Interrupt the current OpenCode task");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const job = getCurrentJob();
  const res = await stopCurrentJob();
  if (!res.ok) {
    await interaction.reply({ embeds: [errorEmbed("Nothing to stop", res.message)], ephemeral: true });
    return;
  }
  await interaction.reply({
    embeds: [
      baseEmbed(Colors.Orange)
        .setTitle("■ Stop requested")
        .setDescription(res.message)
        .addFields(
          { name: "Session", value: job ? `\`${job.sessionId.slice(0, 8)}\`` : "—", inline: true },
          { name: "Prompt", value: job ? `\`${job.item.prompt.slice(0, 80)}\`` : "—", inline: false },
        )
        .setFooter({ text: "OpenCode Remote" }),
    ],
  });
}