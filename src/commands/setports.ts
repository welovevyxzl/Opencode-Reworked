import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { loadConfig, saveConfig } from "../storage/index.js";
import { checkPort } from "../system/index.js";

export const data = new SlashCommandBuilder()
  .setName("setports")
  .setDescription("Configure OpenCode port or port range")
  .addIntegerOption((o) => o.setName("port").setDescription("Primary OpenCode port").setRequired(false).setMinValue(1024).setMaxValue(65535))
  .addIntegerOption((o) => o.setName("min").setDescription("Range minimum").setRequired(false).setMinValue(1024).setMaxValue(65535))
  .addIntegerOption((o) => o.setName("max").setDescription("Range maximum").setRequired(false).setMinValue(1024).setMaxValue(65535));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const port = interaction.options.getInteger("port");
  const min = interaction.options.getInteger("min");
  const max = interaction.options.getInteger("max");

  if (min !== null && max !== null && min > max) {
    await interaction.reply({ content: "Range min must be <= max.", ephemeral: true });
    return;
  }

  const config = loadConfig();
  if (!config) {
    await interaction.reply({ content: "No configuration. Run `ocr setup` first.", ephemeral: true });
    return;
  }

  if (port !== null) {
    const check = await checkPort(port);
    if (check.inUse && !portAlreadyOwned(port)) {
      await interaction.reply({
        content: `Port ${port} is already in use by ${check.processName || check.pid || "unknown"}. Choose another port or free it first.`,
        ephemeral: true,
      });
      return;
    }
    config.opencode.port = port;
  }
  if (min !== null) config.opencode.portRangeMin = min;
  if (max !== null) config.opencode.portRangeMax = max;

  saveConfig(config);
  await interaction.reply({
    content:
      `✓ Port config saved.\n` +
      `Port: \`${config.opencode.port}\`\n` +
      `Range: \`${config.opencode.portRangeMin ?? "—"}–${config.opencode.portRangeMax ?? "—"}\``,
    ephemeral: true,
  });
}

function portAlreadyOwned(port: number): boolean {
  return port === loadConfig()?.opencode.port;
}