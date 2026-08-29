import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show all commands grouped by category");

const GROUPS: Array<{ title: string; commands: Array<[string, string]> }> = [
  {
    title: "OpenCode",
    commands: [
      ["/opencode prompt:<text>", "Send a prompt to OpenCode"],
      ["/task start …", "Tracked task with autopilot mode (iterate until done)"],
      ["/code mode:<inherit|enabled|disabled>", "Passthrough mode for this thread"],
      ["/autocode mode:<…>", "Passthrough default for this channel"],
      ["/model", "List / set / show current model"],
      ["/stop", "Cancel the current task"],
    ],
  },
  {
    title: "Queue & jobs",
    commands: [
      ["/queue status|list|pause|resume", "Queue control"],
      ["/queue clear include_running:<bool>", "Clear queued jobs"],
      ["/job current|info|retry|cancel|list", "Inspect and manage jobs"],
      ["/logs job:<id>", "Logs filtered by job"],
    ],
  },
  {
    title: "Projects",
    commands: [
      ["/setpath alias:<a> path:<path>", "Register a project"],
      ["/projects", "Show registered projects"],
      ["/use project:<alias>", "Bind a project to this channel"],
      ["/files", "Browse files (no secrets)"],
      ["/memory show|add|clear", "Persistent project memory (.ocr/memory.md)"],
    ],
  },
  {
    title: "Sessions & Git",
    commands: [
      ["/session list|new|attach|detach|info|delete|rename", "Manage sessions"],
      ["/diff type:<unstaged|staged|branch>", "Show Git diff"],
      ["/git status|branch|checkout|pull|push|commit|log", "Git operations"],
      ["/work branch:<b>", "Create isolated worktree"],
      ["/github status|repo|create|pr|prs", "GitHub via gh CLI"],
    ],
  },
  {
    title: "System",
    commands: [
      ["/status", "Full system + build status"],
      ["/doctor", "Diagnostics with fixes"],
      ["/remote status|info|rustdesk|tailscale", "Remote access info (owner)"],
      ["/pc status|sleep|lock|restart|shutdown", "PC controls (owner only)"],
      ["/voice status|enable|disable", "Voice transcription"],
    ],
  },
  {
    title: "Administration",
    commands: [
      ["/allow add|remove|list", "Manage authorization (owner only)"],
      ["/setports port:<n>", "OpenCode port config"],
    ],
  },
];

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("Commands")
    .setFooter({ text: "OpenCode Remote" });

  for (const group of GROUPS) {
    embed.addFields({
      name: group.title,
      value: group.commands.map(([cmd, desc]) => `\`${cmd}\` — ${desc}`).join("\n"),
    });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
