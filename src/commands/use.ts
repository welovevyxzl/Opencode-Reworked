import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { loadConfig, getChannelBinding, saveChannelBinding } from "../storage/index.js";

export const data = new SlashCommandBuilder()
  .setName("use")
  .setDescription("Select which registered project this channel controls")
  .addStringOption((opt) =>
    opt.setName("project").setDescription("Project alias").setRequired(true).setAutocomplete(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const config = loadConfig();
  const projectAlias = interaction.options.getString("project", true).trim().toLowerCase();

  if (!config || config.projects.registered.length === 0) {
    await interaction.reply({ content: "No projects registered. Use `/setpath` to add one.", ephemeral: true });
    return;
  }
  const project = config.projects.registered.find((p) => p.alias === projectAlias);
  if (!project) {
    await interaction.reply({ content: `Project \`${projectAlias}\` not found. Projects: ${config.projects.registered.map((p) => `\`${p.alias}\``).join(", ")}`, ephemeral: true });
    return;
  }

  const binding = getChannelBinding(interaction.channelId) || {
    channelId: interaction.channelId,
    projectAlias,
    autocode: "inherit",
    threadSessionMap: new Map<string, string>(),
  };
  binding.projectAlias = projectAlias;
  saveChannelBinding(binding);

  await interaction.reply({ content: `This channel now controls **${projectAlias}** (\`${project.path}\`).`, ephemeral: true });
}

export async function autocomplete(
  interaction: import("discord.js").AutocompleteInteraction
): Promise<void> {
  const config = loadConfig();
  const focused = interaction.options.getFocused();
  const projects = (config?.projects.registered ?? []).filter((p) =>
    p.alias.toLowerCase().includes(focused.toLowerCase())
  );
  await interaction.respond(projects.map((p) => ({ name: p.alias, value: p.alias })).slice(0, 25));
}