import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { stopCurrentJob, getActiveJobView } from "../opencode/engine.js";
import { baseEmbed, errorEmbed } from "../discord/ui.js";
import { Colors } from "discord.js";
import { truncate } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Interrupt the current OpenCode task");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Idempotent: repeated /stop calls are safe and report current state.
  const view = getActiveJobView();
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
          { name: "Job", value: view ? `\`${view.job.id.slice(0, 8)}\`` : "—", inline: true },
          { name: "Session", value: view?.job.sessionId ? `\`${view.job.sessionId.slice(0, 8)}\`` : "—", inline: true },
          { name: "Prompt", value: view ? truncate(view.job.prompt, 80) : "—", inline: false }
        )
        .setFooter({ text: "OpenCode Remote" }),
    ],
  });
}
