import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getChannelBinding, getProjectState } from "../storage/index.js";
import { getDiff, diffToFile } from "../git/index.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("diff")
  .setDescription("Show Git diff for the bound project")
  .addStringOption((o) =>
    o.setName("type").setDescription("Which diff").setRequired(false).addChoices(
      { name: "unstaged", value: "unstaged" },
      { name: "staged", value: "staged" },
      { name: "branch", value: "branch" }
    )
  )
  .addStringOption((o) => o.setName("base").setDescription("Base ref for branch diff (default HEAD)").setRequired(false))
  .addBooleanOption((o) => o.setName("stat").setDescription("Show only stats").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = interaction.channelId;
  const binding = getChannelBinding(channelId);
  if (!binding) {
    await interaction.reply({ content: "No project bound to this channel. Use `/use`.", ephemeral: true });
    return;
  }
  const state = getProjectState(binding.projectAlias);
  if (!state || !state.path) {
    await interaction.reply({ content: `Project \`${binding.projectAlias}\` not found.`, ephemeral: true });
    return;
  }

  const type = (interaction.options.getString("type") as "unstaged" | "staged" | "branch") || "unstaged";
  const base = interaction.options.getString("base") || undefined;
  const stat = interaction.options.getBoolean("stat") ?? false;

  await interaction.deferReply();

  const res = await getDiff(state.path, { type, base, stat });
  if (!res.ok) {
    await interaction.editReply({ content: `${Icons.fail} ${res.error || "Diff failed"}` });
    return;
  }
  if (!res.output) {
    await interaction.editReply({ content: "No changes." });
    return;
  }

  const lines = res.output.split("\n");
  const summary = {
    files: lines.filter((l) => l.startsWith("diff --git")).length,
    adds: lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length,
    del: lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length,
  };

  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle("Git Diff")
    .setFooter({ text: "OpenCode Remote" })
    .addFields(
      { name: "Files", value: `${summary.files}`, inline: true },
      { name: "Added", value: `+${summary.adds}`, inline: true },
      { name: "Removed", value: `-${summary.del}`, inline: true }
    );

  const MAX_CHAR = 3500;
  const code = res.output.length > MAX_CHAR ? res.output.slice(0, MAX_CHAR) + "\n…" : res.output;
  embed.setDescription("```diff\n" + code + "\n```");

  if (res.output.length > 4096) {
    const file = await diffToFile(state.path, res.output);
    await interaction.editReply({ embeds: [embed], files: [file] });
  } else {
    await interaction.editReply({ embeds: [embed] });
  }
}