import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getBotStatus } from "../discord/bot.js";
import { getServerInfo, isHealthy, isUnhealthy } from "../opencode/manager.js";
import { getEngineStatus, queueSettings } from "../opencode/engine.js";
import * as qs from "../opencode/queue-service.js";
import { loadConfig, getChannelBinding, getProjectState } from "../storage/index.js";
import { getStatus } from "../git/index.js";
import { isAuthenticated } from "../github/index.js";
import { getMemoryUsage, formatDuration } from "../utils/index.js";
import { getBuildInfo } from "../utils/build-info.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("status")
  .setDescription("Show full status of the bot, build, and machine");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  const config = loadConfig();
  if (!config) {
    await interaction.editReply({ content: "No configuration found." });
    return;
  }

  const build = getBuildInfo();
  const bot = getBotStatus();
  const ocHealthy = await isHealthy();
  const server = getServerInfo();
  const engine = getEngineStatus();
  const settings = queueSettings();
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
  const stats = qs.getQueueStats();
  const active = qs.getActiveJob();

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("OpenCode Remote")
    .setDescription(
      `**${stats.paused ? "⏸ Queue paused" : "▶ Queue active"}**${engine.running ? ` · job \`${engine.jobId?.slice(0, 8)}\` ${engine.runtimeStatus ?? "working"}` : ""}`
    )
    .setFooter({ text: `v${build.version} · built ${build.builtAt ? new Date(build.builtAt).toISOString().slice(0, 16) + " UTC" : "?"} · ${build.runningFrom}${build.sourceChangedSinceBuild ? " · ⚠ src changed since build" : ""}` });

  embed.addFields(
    { name: "Bot", value: bot.connected ? `${Icons.running} online · ${bot.tag} · up ${formatDuration(bot.uptime)}` : `${Icons.fail} offline`, inline: false },
    { name: "OpenCode", value: `${ocHealthy ? Icons.running + " healthy" : isUnhealthy() ? Icons.fail + " unhealthy" : Icons.idle + " not reachable"} · \`${server.host}:${server.port}\``, inline: true },
    { name: "Queue", value: `${stats.queued} queued · ${stats.active} active${stats.paused ? " · paused" : ""}`, inline: true },
    { name: "Settings", value: `fail→continue **${settings.continueOnFailure ? "on" : "off"}**`, inline: true },
    { name: "Project", value: binding ? `\`${binding.projectAlias}\`${state?.path ? ` · \`${state.path}\`` : ""}` : "none", inline: false },
    { name: "Model", value: state?.selectedModel || "default", inline: true },
    { name: "Session", value: active?.sessionId ? `\`${active.sessionId.slice(0, 12)}\`` : "—", inline: true },
    { name: "Last action", value: engine.lastAction ? `\`${engine.lastAction.slice(0, 40)}\`` : "—", inline: true },
    { name: "Git branch", value: `\`${branch}\``, inline: true },
    { name: "Git status", value: gitClean.startsWith("clean") ? `${Icons.ok} ${gitClean}` : `${Icons.idle} ${gitClean}`, inline: true },
    { name: "GitHub", value: gh ? `${Icons.ok} authenticated` : `${Icons.idle} not authenticated`, inline: true },
    { name: "Memory", value: `${mem.used} MB / ${mem.total} MB heap`, inline: true },
    { name: "Node", value: process.version, inline: true },
    { name: "Platform", value: process.platform, inline: true }
  );

  if (active) {
    embed.addFields({
      name: "Running job",
      value: `\`${active.id.slice(0, 8)}\` · attempt ${active.attemptCount} · ${engine.runtimeStatus ?? active.status}`,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
