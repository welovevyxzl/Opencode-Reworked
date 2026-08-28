import { SlashCommandBuilder, ChatInputCommandInteraction, StringSelectMenuBuilder, ActionRowBuilder, EmbedBuilder, Colors } from "discord.js";
import { loadConfig, getChannelBinding } from "../storage/index.js";
import { getStatus, containsGitRepo } from "../git/index.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("projects")
  .setDescription("Show registered projects");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const config = loadConfig();
  if (!config || config.projects.registered.length === 0) {
    await interaction.reply({ content: "No projects registered. Use `/setpath` to add one.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const binding = getChannelBinding(interaction.channelId);
  const currentAlias = binding?.projectAlias;

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setFooter({ text: "OpenCode Remote" });

  for (const project of config.projects.registered) {
    const bound = project.alias === currentAlias;
    let branch = "—";
    let isRepo = false;
    if (containsGitRepo(project.path)) {
      const status = await getStatus(project.path);
      branch = status?.branch ?? "—";
      isRepo = true;
    }
    embed.addFields({
      name: `${bound ? `${Icons.running} ` : ""}${project.alias}`,
      value: `\`${project.path}\`\nbranch: \`${branch}\` · ${isRepo ? "git" : "no git"} · ${bound ? "**bound**" : "not bound"}`,
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`sb_use_pick`)
    .setPlaceholder("Bind a project to this channel")
    .addOptions(
      config.projects.registered.map((p) => ({
        label: p.alias,
        value: p.alias,
        description: p.path,
      }))
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.editReply({ embeds: [embed], components: [row] });
}