import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getChannelBinding, getProjectState } from "../storage/index.js";
import { loadProjectContext, addMemoryEntry, clearMemory, getMemoryPath } from "../opencode/project-context.js";
import { isOwner } from "../storage/index.js";
import { errorEmbed, Icons } from "../discord/ui.js";
import { truncate } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("memory")
  .setDescription("Manage persistent project memory (.ocr/memory.md)")
  .addSubcommand((s) => s.setName("show").setDescription("Show this project's memory"))
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add a durable note to project memory")
      .addStringOption((o) => o.setName("note").setDescription("What to remember (decision, command, constraint…)").setRequired(true))
  )
  .addSubcommand((s) => s.setName("clear").setDescription("Clear project memory (owner only)"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  const binding = getChannelBinding(interaction.channelId);
  const inThread = interaction.channel?.isThread?.();
  const { getThreadSession } = await import("../storage/index.js");
  const ts = inThread ? getThreadSession(interaction.channelId) : null;
  const alias = ts?.projectAlias || binding?.projectAlias;
  if (!alias) {
    await interaction.reply({ embeds: [errorEmbed("No project bound", "Use `/use` first (or run this inside an OpenCode thread).")], ephemeral: true });
    return;
  }
  const state = getProjectState(alias);
  if (!state?.path) {
    await interaction.reply({ embeds: [errorEmbed("Project not found", `\`${alias}\``)], ephemeral: true });
    return;
  }

  if (sub === "show") {
    const ctx = loadProjectContext(state.path);
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`Memory · ${alias}`)
      .setFooter({ text: getMemoryPath(state.path) })
      .setDescription(
        ctx.memory
          ? truncate(ctx.memory, 3900)
          : "No project memory yet. Add durable notes with `/memory add`."
      );
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === "add") {
    const note = interaction.options.getString("note", true).trim();
    if (note.length > 500) {
      await interaction.reply({ content: "Note too long (max 500 chars) — memory is curated, not a transcript.", ephemeral: true });
      return;
    }
    const res = addMemoryEntry(state.path, note, interaction.user.username);
    if (!res.ok) {
      await interaction.reply({ content: `× ${res.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `${Icons.ok} Added to \`${alias}\` project memory. It will be included in future coding prompts.`, ephemeral: true });
    return;
  }

  if (sub === "clear") {
    if (!isOwner(interaction.user.id)) {
      await interaction.reply({ content: "Only the owner can clear project memory.", ephemeral: true });
      return;
    }
    const res = clearMemory(state.path);
    await interaction.reply({ content: res.ok ? `${Icons.ok} Memory cleared for \`${alias}\`.` : `× ${res.error}`, ephemeral: true });
  }
}
