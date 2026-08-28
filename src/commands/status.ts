import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getBotStatus } from "../discord/bot.js";
import { getServerInfo, isHealthy, isUnhealthy, getBinaryPath } from "../opencode/manager.js";
import { getQueueSnapshot, getCurrentJob } from "../opencode/engine.js";
import { loadConfig, getChannelBinding, getProjectState } from "../storage/index.js";
import { getStatus } from "../git/index.js";
import { isAuthenticated } from "../github/index.js";
import { getMemoryUsage } from "../utils/index.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show full status of the bot and machine");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  const config = loadConfig();
  if (!config) {
    await interaction.editReply({ content: "No configuration found." });
    return;
  }

  const bot = getBotStatus();
  const ocHealthy = await isHealthy();
  const server = getServerInfo();
  const queue = getQueueSnapshot();
  const running = getCurrentJob();
  const binding = getChannelBinding(interaction.channelId);
  const state = binding ? getProjectState(binding.projectAlias) : null;

  let branch = "—";
  let gitClean = "—";
  if (state?.path) {
    const status = await getStatus(state.path);
    if (status) {
      branch = status.branch || "—";
      gitClean = status.clean ? "clean" : `${status.staged.length} staged · ${status.modified.length} modified · ${status.untracked.length} untracked`;
    }
  }

  const mem = getMemoryUsage();
  const gh = await isAuthenticated();

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("System Status")
    .setFooter({ text: "OpenCode Remote" });

  embed.addFields(
    { name: "Bot", value: bot.connected ? `${Icons.running} online · ${bot.tag} · up ${formatUptime(bot.uptime)}` : `${Icons.fail} offline`, inline: false },
    { name: "OpenCode", value: ocHealthy ? `${Icons.running} healthy` : isUnhealthy() ? `${Icons.fail} unhealthy` : `${Icons.idle} not reachable`, inline: true },
    { name: "Server", value: `\`${server.host}:${server.port}\``, inline: true },
    { name: "Binary", value: getBinaryPath() ? `\`${getBinaryPath()}\`` : "not detected", inline: false },
    { name: "Project", value: binding ? `\`${binding.projectAlias}\`` : "none", inline: true },
    { name: "Path", value: state?.path ? `\`${state.path}\`` : "—", inline: true },
    { name: "Session", value: running ? `\`${running.sessionId.slice(0, 12)}\`` : "—", inline: true },
    { name: "Model", value: state?.selectedModel || "default", inline: true },
    { name: "Queue", value: `${queue.filter((q) => q.status === "queued").length} queued`, inline: true },
    { name: "Git branch", value: `\`${branch}\``, inline: true },
    { name: "Git status", value: gitClean.startsWith("clean") ? `${Icons.ok} ${gitClean}` : `${Icons.idle} ${gitClean}`, inline: true },
    { name: "Memory", value: `${mem.used} MB / ${mem.total} MB`, inline: true },
    { name: "Node", value: process.version, inline: true },
    { name: "Platform", value: process.platform, inline: true },
    { name: "GitHub", value: gh ? `${Icons.ok} authenticated` : `${Icons.idle} not authenticated`, inline: true }
  );

  await interaction.editReply({ embeds: [embed] });
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}