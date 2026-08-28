import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { loadConfig, saveConfig } from "../storage/index.js";
import { isValidPath, safePath } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("setpath")
  .setDescription("Register a project path with an alias")
  .addStringOption((opt) =>
    opt.setName("alias").setDescription("Short alias for the project").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("path").setDescription("Absolute path to the project").setRequired(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const alias = interaction.options.getString("alias", true).trim().toLowerCase();
  const rawPath = interaction.options.getString("path", true).trim();

  if (!/^[a-z0-9_-]{2,32}$/.test(alias)) {
    await interaction.reply({ content: "Alias must be 2-32 chars: letters, digits, `_` or `-`.", ephemeral: true });
    return;
  }

  if (!rawPath.startsWith("\\") && !/^[a-zA-Z]:[\\/]/.test(rawPath) && !rawPath.startsWith("/")) {
    await interaction.reply({ content: "Path must be absolute (e.g. D:\\Projects\\website).", ephemeral: true });
    return;
  }

  const resolved = safePath(rawPath);
  if (!isValidPath(resolved)) {
    await interaction.reply({ content: `Directory does not exist: \`${resolved}\``, ephemeral: true });
    return;
  }

  const config = loadConfig();
  if (!config) {
    await interaction.reply({ content: "No configuration. Run `ocr setup` first.", ephemeral: true });
    return;
  }

  const existing = config.projects.registered.findIndex((p) => p.alias === alias);
  if (existing >= 0) {
    config.projects.registered[existing].path = resolved;
    await interaction.reply({ content: `Updated \`${alias}\` -> \`${resolved}\``, ephemeral: true });
  } else {
    config.projects.registered.push({ alias, path: resolved });
    await interaction.reply({ content: `Registered \`${alias}\` -> \`${resolved}\``, ephemeral: true });
  }
  saveConfig(config);
}