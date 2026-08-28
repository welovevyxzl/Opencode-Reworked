import { SlashCommandBuilder, ChatInputCommandInteraction, ThreadChannel, Colors } from "discord.js";
import { getChannelBinding, saveChannelBinding } from "../storage/index.js";
import { baseEmbed } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("code")
  .setDescription("Toggle passthrough mode (plain messages go to OpenCode) for this thread");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!(channel instanceof ThreadChannel)) {
    await interaction.reply({ content: "This command must be run inside a thread (created by /opencode).", ephemeral: true });
    return;
  }

  const parentId = (channel.parentId || interaction.channelId) as string;
  const binding = getChannelBinding(parentId);
  if (!binding) {
    await interaction.reply({ content: "No project bound to this thread's channel. Use `/use` first.", ephemeral: true });
    return;
  }

  binding.autocodeEnabled = !binding.autocodeEnabled;
  saveChannelBinding(binding);

  const enabled = binding.autocodeEnabled;
  await interaction.reply({
    embeds: [
      baseEmbed(enabled ? Colors.Green : Colors.Grey)
        .setTitle(enabled ? "✓ Passthrough enabled" : "Passthrough disabled")
        .setDescription(
          enabled
            ? "Messages in this thread now go directly to OpenCode."
            : "Messages in this thread no longer go to OpenCode."
        )
        .setFooter({ text: "OpenCode Remote" }),
    ],
    ephemeral: true,
  });
}