import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction } from "discord.js";
import { loadConfig, saveConfig } from "../storage/index.js";
import { isValidPath, safePath } from "../utils/index.js";
import { successEmbed, errorEmbed } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("setpath")
  .setDescription("Register a project path with an alias")
  .addStringOption((opt) =>
    opt.setName("alias").setDescription("Short alias for the project").setRequired(true).setAutocomplete(true)
  )
  .addStringOption((opt) =>
    opt.setName("path").setDescription("Absolute path to the project").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const alias = interaction.options.getString("alias", true).trim().toLowerCase();
  const rawPath = interaction.options.getString("path", true).trim();

  if (!/^[a-z0-9_-]{2,32}$/.test(alias)) {
    await interaction.reply({ embeds: [errorEmbed("Invalid alias", "Alias must be 2-32 chars: letters, digits, `_` or `-`.")], ephemeral: true });
    return;
  }

  if (!rawPath.startsWith("\\") && !/^[a-zA-Z]:[\\/]/.test(rawPath) && !rawPath.startsWith("/")) {
    await interaction.reply({ embeds: [errorEmbed("Invalid path", "Path must be absolute (e.g. `D:\\Projects\\website`).")], ephemeral: true });
    return;
  }

  const resolved = safePath(rawPath);
  if (!isValidPath(resolved)) {
    await interaction.reply({ embeds: [errorEmbed("Directory not found", `\`${resolved}\``)], ephemeral: true });
    return;
  }

  const config = loadConfig();
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed("No configuration", "Run `ocr setup` first.")], ephemeral: true });
    return;
  }

  const existing = config.projects.registered.findIndex((p) => p.alias === alias);
  if (existing >= 0) {
    config.projects.registered[existing].path = resolved;
    await interaction.reply({ embeds: [successEmbed("Project updated", `\`${alias}\` → \`${resolved}\``)], ephemeral: true });
  } else {
    config.projects.registered.push({ alias, path: resolved });
    await interaction.reply({ embeds: [successEmbed("Project registered", `\`${alias}\` → \`${resolved}\``)], ephemeral: true });
  }
  saveConfig(config);
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const config = loadConfig();
  const projects = config?.projects?.registered ?? [];
  const focused = interaction.options.getFocused();
  const choices = projects
    .filter((p) => p.alias.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((p) => ({ name: `${p.alias} (${p.path})`, value: p.alias }));
  await interaction.respond(choices);
}