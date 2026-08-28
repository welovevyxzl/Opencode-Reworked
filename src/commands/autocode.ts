import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { getChannelBinding, saveChannelBinding, getProjectState } from "../storage/index.js";

export const data = new SlashCommandBuilder()
  .setName("autocode")
  .setDescription("Enable or disable automatic passthrough for new OpenCode threads in the current project")
  .addBooleanOption((opt) =>
    opt.setName("enabled").setDescription("Enable/disable autocode for the bound project").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const enabled = interaction.options.getBoolean("enabled", true);
  const binding = getChannelBinding(interaction.channelId);

  if (!binding) {
    await interaction.reply({ content: "No project bound to this channel. Use `/use` first.", ephemeral: true });
    return;
  }

  const state = getProjectState(binding.projectAlias);
  if (!state) {
    await interaction.reply({ content: `Project \`${binding.projectAlias}\` not found.`, ephemeral: true });
    return;
  }

  binding.autocodeEnabled = enabled;
  saveChannelBinding(binding);

  await interaction.reply({
    content: enabled
      ? `✓ Autocode **enabled** for project \`${binding.projectAlias}\`. New threads will auto-send messages to OpenCode.`
      : `Autocode **disabled** for project \`${binding.projectAlias}\`.`,
    ephemeral: true,
  });
}