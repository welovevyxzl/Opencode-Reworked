import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getRecentLogs } from "../utils/logger.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("logs")
  .setDescription("Show recent bot logs")
  .addIntegerOption((o) => o.setName("lines").setDescription("Number of lines").setRequired(false).setMinValue(1).setMaxValue(100))
  .addStringOption((o) => o.setName("level").setDescription("Minimum level").setRequired(false).addChoices({ name: "DEBUG", value: "DEBUG" }, { name: "INFO", value: "INFO" }, { name: "WARN", value: "WARN" }, { name: "ERROR", value: "ERROR" }))
  .addStringOption((o) => o.setName("job").setDescription("Filter by job id (short form works)").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const lines = interaction.options.getInteger("lines") ?? 30;
  const level = (interaction.options.getString("level") as "DEBUG" | "INFO" | "WARN" | "ERROR") || "INFO";
  const jobId = interaction.options.getString("job") ?? undefined;

  await interaction.deferReply({ ephemeral: true });

  const entries = getRecentLogs(lines, level, jobId);
  if (entries.length === 0) {
    await interaction.editReply({
      content: jobId ? `No log entries for job \`${jobId}\`.` : "No logs available yet.",
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`Logs${jobId ? ` · job ${jobId.slice(0, 12)}` : ""} (last ${entries.length})`)
    .setFooter({ text: "OpenCode Remote · secrets redacted" });

  let description = "";
  for (const e of entries) {
    const icon = e.level === "ERROR" ? Icons.fail : e.level === "WARN" ? "⚠" : e.level === "DEBUG" ? "◦" : Icons.ok;
    const event = e.event ? ` ${e.event}` : "";
    const line = `${icon} ${new Date(e.timestamp).toLocaleTimeString()} [${e.level}]${event} ${e.message.slice(0, 150)}`;
    description += line + "\n";
    if (description.length > 3000) break;
  }
  embed.setDescription("```\n" + description.slice(0, 4000) + "\n```");
  await interaction.editReply({ embeds: [embed] });
}
