import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getAllowlist, addToAllowlist, removeFromAllowlist, isOwner } from "../storage/index.js";

export const data = new SlashCommandBuilder()
  .setName("allow")
  .setDescription("Manage authorized users (owner only)")
  .addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add a user to the allowlist")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Remove a user from the allowlist")
      .addUserOption((o) => o.setName("user").setDescription("Discord user").setRequired(true))
  )
  .addSubcommand((s) => s.setName("list").setDescription("List authorized users"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    const entries = getAllowlist();
    if (entries.length === 0) {
      await interaction.reply({ content: "No authorized users.", ephemeral: true });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("Authorized users")
      .setFooter({ text: "OpenCode Remote" });
    for (const e of entries) {
      embed.addFields({
        name: `${e.isOwner ? "👑 " : ""}${e.username}`,
        value: `<@${e.userId}>` + (e.isOwner ? " · owner" : ""),
        inline: true,
      });
    }
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  const target = interaction.options.getUser("user", true);
  const targetId = target.id;

  if (targetId === interaction.user.id && sub === "remove" && isOwner(targetId)) {
    await interaction.reply({ content: "You cannot remove yourself as the owner while being the only owner.", ephemeral: true });
    return;
  }

  if (sub === "add") {
    const existing = getAllowlist().find((e) => e.userId === targetId);
    if (existing) {
      await interaction.reply({ content: `<@${targetId}> is already authorized.`, ephemeral: true });
      return;
    }
    addToAllowlist({
      userId: targetId,
      username: target.username,
      addedAt: Date.now(),
      addedBy: interaction.user.id,
      isOwner: false,
    });
    await interaction.reply({ content: `✓ Added <@${targetId}> to the allowlist.`, ephemeral: true });
    return;
  }

  if (sub === "remove") {
    const ok = removeFromAllowlist(targetId);
    if (!ok) {
      await interaction.reply({
        content: "Could not remove that user. You cannot remove the last authorized user or the owner.",
        ephemeral: true,
      });
      return;
    }
    await interaction.reply({ content: `Removed <@${targetId}> from the allowlist.`, ephemeral: true });
  }
}