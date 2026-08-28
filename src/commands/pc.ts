import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getSystemStatus } from "../system/index.js";
import { registerConfirmation } from "./confirmations.js";
import { Icons } from "../discord/ui.js";
import { lockScreen } from "../system/index.js";

export const data = new SlashCommandBuilder()
  .setName("pc")
  .setDescription("PC controls (owner only)")
  .addSubcommand((s) => s.setName("status").setDescription("Show PC status"))
  .addSubcommand((s) => s.setName("sleep").setDescription("Put PC to sleep (requires confirmation)"))
  .addSubcommand((s) => s.setName("lock").setDescription("Lock the PC immediately"))
  .addSubcommand((s) => s.setName("restart").setDescription("Restart the PC (requires confirmation)"))
  .addSubcommand((s) => s.setName("shutdown").setDescription("Shut down the PC (requires confirmation)"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "status") {
    const status = await getSystemStatus();
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("PC Status")
      .setFooter({ text: "OpenCode Remote" })
      .addFields(
        { name: "Uptime", value: uptime(status.uptimeMs), inline: true },
        { name: "CPU", value: `${status.cpuModel}`, inline: false },
        { name: "Cores", value: `${status.cores}`, inline: true },
        { name: "Memory", value: `${status.freeMemoryGb}/${status.totalMemoryGb} GB free`, inline: true },
        { name: "Host", value: status.hostname, inline: true },
        { name: "OS", value: status.osVersion, inline: true },
        { name: "Last boot", value: status.lastBoot || "unknown", inline: true }
      );
    await interaction.reply({ embeds: [embed], ephemeral: false });
    return;
  }

  if (sub === "lock") {
    const res = await lockScreen();
    if (!res.ok) {
      await interaction.reply({ content: `${Icons.fail} Could not lock: ${res.error}`, ephemeral: true });
      return;
    }
    await interaction.reply({ content: `${Icons.ok} Locked.` });
    return;
  }

  // sleep, restart, shutdown all require confirmation
  if (sub === "sleep" || sub === "restart" || sub === "shutdown") {
    await interaction.deferReply();
    await registerConfirmation(interaction, sub);
    return;
  }
}

function uptime(ms: number): string {
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}