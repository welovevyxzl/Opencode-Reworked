import { SlashCommandBuilder, ChatInputCommandInteraction, ThreadChannel, Colors } from "discord.js";
import { getChannelBinding, saveChannelBinding, getProjectState } from "../storage/index.js";
import { baseEmbed, errorEmbed } from "../discord/ui.js";
import type { AutocodeMode } from "../types/index.js";

export const data = new SlashCommandBuilder()
  .setName("autocode")
  .setDescription("Configure automatic passthrough for this channel (new OpenCode threads inherit it)")
  .addStringOption((opt) =>
    opt
      .setName("mode")
      .setDescription("Autocode mode for this channel / project default")
      .setRequired(true)
      .addChoices(
        { name: "enabled — threads here auto-send messages", value: "enabled" },
        { name: "disabled — threads here never auto-send", value: "disabled" },
        { name: "inherit — remove this channel's override", value: "inherit" }
      )
  )
  .addBooleanOption((opt) =>
    opt.setName("apply_to_threads").setDescription("Also reset existing thread overrides to inherit (default true)").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const mode = interaction.options.getString("mode", true) as AutocodeMode;
  const applyToThreads = interaction.options.getBoolean("apply_to_threads") ?? true;

  const channel = interaction.channel;
  const inThread = channel instanceof ThreadChannel;
  const channelId = inThread ? (channel.parentId ?? channel.id) : interaction.channelId;

  const binding = getChannelBinding(channelId);
  if (!binding) {
    await interaction.reply({ embeds: [errorEmbed("No project bound", `Use \`/use\` in this channel first (this command targets the **channel**, not the project).`)], ephemeral: true });
    return;
  }
  const state = getProjectState(binding.projectAlias);
  if (!state) {
    await interaction.reply({ embeds: [errorEmbed("Project not found", `\`${binding.projectAlias}\``)], ephemeral: true });
    return;
  }

  binding.autocode = mode;
  saveChannelBinding(binding);

  // When changing a parent channel, existing thread overrides stay explicit
  // (that is the point of explicit inheritance) unless reset was requested.
  let resetCount = 0;
  if (!inThread && applyToThreads && mode !== "inherit") {
    const { getDatabase } = await import("../storage/index.js");
    const db = getDatabase();
    if (db) {
      const res = db
        .prepare(
          "UPDATE channel_bindings SET autocode_mode = 'inherit' WHERE channel_id IN (SELECT thread_id FROM thread_sessions WHERE channel_id = ?) AND autocode_mode != 'inherit'"
        )
        .run(channelId);
      resetCount = res.changes;
    }
  }

  const scope = inThread ? "this thread's parent channel" : "this channel";
  const effect =
    mode === "enabled"
      ? `Threads in ${scope} inherit passthrough **on** (they can still override with \`/code\`).`
      : mode === "disabled"
        ? `Threads in ${scope} inherit passthrough **off** (a thread explicitly enabled with \`/code\` stays on).`
        : `Override removed for ${scope}; threads fall back to their own setting.`;

  await interaction.reply({
    embeds: [
      baseEmbed(mode === "enabled" ? Colors.Green : mode === "disabled" ? Colors.Grey : Colors.Blue)
        .setTitle(mode === "enabled" ? "✓ Autocode enabled" : mode === "disabled" ? "Autocode disabled" : "Autocode override removed")
        .setDescription(
          `${effect}${resetCount > 0 ? `\n\nReset ${resetCount} thread override(s) to inherit.` : ""}`
        )
        .setFooter({ text: `Channel: ${channelId} · Project: ${binding.projectAlias}` }),
    ],
    ephemeral: true,
  });
}
