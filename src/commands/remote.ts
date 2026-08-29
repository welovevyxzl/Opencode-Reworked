import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getRemoteAccessReport, formatRemoteAccess } from "../system/remote-access.js";
import { getSystemStatus } from "../system/index.js";
import { isOwner } from "../storage/index.js";
import { errorEmbed } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("remote")
  .setDescription("Remote access info for this PC (owner only)")
  .addSubcommand((s) => s.setName("status").setDescription("Whether remote access is available"))
  .addSubcommand((s) => s.setName("info").setDescription("Connection info (redacted, ephemeral)"))
  .addSubcommand((s) => s.setName("rustdesk").setDescription("RustDesk details"))
  .addSubcommand((s) => s.setName("tailscale").setDescription("Tailscale details"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  // Owner gate at the command layer; the execution layer re-verifies below.
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ embeds: [errorEmbed("Owner only", "Remote access info is restricted to the machine owner.")], ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const sub = interaction.options.getSubcommand();
  const report = await getRemoteAccessReport();
  const lines = formatRemoteAccess(report);

  if (sub === "status") {
    const anyAvailable = report.rustdesk.installed || report.tailscale.installed;
    await interaction.editReply({
      content: anyAvailable
        ? `Remote access available:\n${lines.join("\n")}`
        : "No remote-access tooling detected. Install RustDesk or Tailscale on the PC for remote reachability.",
    });
    return;
  }

  if (sub === "info") {
    const sys = await getSystemStatus();
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("Remote access")
      .setDescription(lines.join("\n"))
      .addFields(
        { name: "Host", value: sys.hostname, inline: true },
        { name: "OS", value: sys.osVersion, inline: true },
        { name: "Uptime", value: `${Math.floor(sys.uptimeMs / 3600000)}h`, inline: true }
      )
      .setFooter({ text: "Values partially redacted · full credentials never leave this PC" });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "rustdesk") {
    await interaction.editReply({
      content: report.rustdesk.installed
        ? `RustDesk installed${report.rustdesk.id ? ` · ID \`${report.rustdesk.id.slice(0, 3)}••••${report.rustdesk.id.slice(-3)}\`` : ""}.\nOpen the RustDesk app on the client device and enter the full ID shown on this PC. The unattended-access password is stored only on this machine.`
        : "RustDesk is not installed on this PC.",
    });
    return;
  }

  if (sub === "tailscale") {
    const t = report.tailscale;
    await interaction.editReply({
      content: t.installed
        ? `Tailscale ${t.running === false ? "installed but **not running** — start it on the PC" : "running"}.\n${
            t.dnsName ? `Connect via \`${t.dnsName}\`` : t.ips?.length ? `Connect via \`${t.ips.join("` or `")}\`` : "No address parsed."
          }\nUse Tailscale's own client (SSH/RDP over tailnet) — no ports are exposed publicly.`
        : "Tailscale is not installed on this PC.",
    });
  }
}
