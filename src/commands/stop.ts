import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { stopCurrentJob } from "../opencode/engine.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Interrupt the current OpenCode task");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const res = await stopCurrentJob();
  if (!res.ok) {
    await interaction.reply({ content: `${res.message}`, ephemeral: true });
    return;
  }
  await interaction.reply({ content: `${Icons.running} ${res.message}` });
}