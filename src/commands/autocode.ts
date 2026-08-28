import { SlashCommandBuilder, ChatInputCommandInteraction, Colors } from "discord.js";
import { getChannelBinding, saveChannelBinding, getProjectState } from "../storage/index.js";
import { baseEmbed, errorEmbed } from "../discord/ui.js";

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
    await interaction.reply({ embeds: [errorEmbed("No project bound", "Use `/use` first.")], ephemeral: true });
    return;
  }

  const state = getProjectState(binding.projectAlias);
  if (!state) {
    await interaction.reply({ embeds: [errorEmbed("Project not found", `\`${binding.projectAlias}\``)], ephemeral: true });
    return;
  }

  binding.autocodeEnabled = enabled;
  saveChannelBinding(binding);

  await interaction.reply({
    embeds: [
      baseEmbed(enabled ? Colors.Green : Colors.Grey)
        .setTitle(enabled ? "✓ Autocode enabled" : "Autocode disabled")
        .setDescription(
          enabled
            ? `New threads in **${binding.projectAlias}** will auto-send messages to OpenCode.`
            : `Autocode turned off for **${binding.projectAlias}**.`
        )
        .setFooter({ text: "OpenCode Remote" }),
    ],
    ephemeral: true,
  });
}