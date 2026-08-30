import { SlashCommandBuilder, ChatInputCommandInteraction, ThreadChannel, Colors } from "discord.js";
import { getChannelBinding, saveChannelBinding, markChannelBindingThread, effectiveAutocode } from "../storage/index.js";
import { baseEmbed } from "../discord/ui.js";
import type { AutocodeMode } from "../types/index.js";

export const data = new SlashCommandBuilder()
  .setName("code")
  .setDescription("Set passthrough mode (plain messages go to OpenCode) for this thread")
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("Passthrough mode for this thread")
      .setRequired(true)
      .addChoices(
        { name: "inherit — follow the parent channel", value: "inherit" },
        { name: "enabled — passthrough on for this thread", value: "enabled" },
        { name: "disabled — passthrough off for this thread", value: "disabled" }
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = interaction.channel;
  if (!(channel instanceof ThreadChannel)) {
    await interaction.reply({ content: "This command must be run inside a thread (created by /opencode).", ephemeral: true });
    return;
  }

  const mode = interaction.options.getString("mode", true) as AutocodeMode;
  const parentId = (channel.parentId || interaction.channelId) as string;
  // Bindings are normally keyed by parent channel ID; fall back to the thread's
  // own binding (e.g. from an older /use run inside the thread) so the command
  // still works even when the parent has no binding.
  const binding = getChannelBinding(parentId) || getChannelBinding(channel.id);
  if (!binding) {
    await interaction.reply({ content: "No project bound to this thread's channel. Use `/use` first.", ephemeral: true });
    return;
  }

  // Threads get their own explicit override row; parent stays untouched.
  const threadBinding = getChannelBinding(channel.id) || {
    channelId: channel.id,
    projectAlias: binding.projectAlias,
    autocode: "inherit" as AutocodeMode,
    threadSessionMap: new Map<string, string>(),
  };
  threadBinding.autocode = mode;
  saveChannelBinding(threadBinding);
  markChannelBindingThread(channel.id, true);

  const effective = effectiveAutocode(channel.id, parentId);
  const descriptions: Record<AutocodeMode, string> = {
    inherit: `This thread now **inherits** from the parent channel (currently **${effective ? "on" : "off"}**).`,
    enabled: "Passthrough is **on for this thread only**. Plain messages here go directly to OpenCode.",
    disabled: "Passthrough is **off for this thread**, even if the parent channel has it enabled.",
  };

  await interaction.reply({
    embeds: [
      baseEmbed(mode === "enabled" ? Colors.Green : mode === "disabled" ? Colors.Grey : Colors.Blue)
        .setTitle(mode === "enabled" ? "✓ Passthrough enabled (this thread)" : mode === "disabled" ? "Passthrough disabled (this thread)" : "Passthrough inherits parent (this thread)")
        .setDescription(descriptions[mode])
        .setFooter({ text: "OpenCode Remote" }),
    ],
    ephemeral: true,
  });
}
