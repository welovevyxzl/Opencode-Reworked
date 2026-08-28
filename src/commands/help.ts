import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("Show all commands grouped by category");

const GROUPS: Array<{ title: string; commands: Array<[string, string]> }> = [
  {
    title: "OpenCode",
    commands: [
      ["/opencode prompt:<text>", "Send a prompt to OpenCode"],
      ["/code", "Toggle passthrough mode for this thread"],
      ["/autocode enabled:<bool>", "Auto-passthrough for new threads"],
      ["/model", "List / set / show current model"],
      ["/queue", "Manage the prompt queue"],
      ["/stop", "Interrupt the current task"],
    ],
  },
  {
    title: "Projects",
    commands: [
      ["/setpath alias:<a> path:<path>", "Register a project"],
      ["/projects", "Show registered projects"],
      ["/use project:<alias>", "Bind a project to this channel"],
      ["/files", "Browse files (no secrets)"],
    ],
  },
  {
    title: "Sessions",
    commands: [
      ["/session list|new|attach|detach|info|delete|rename", "Manage sessions"],
      ["/diff type:<unstaged|staged|branch>", "Show Git diff"],
    ],
  },
  {
    title: "Git",
    commands: [
      ["/git status|branch|checkout|pull|push|commit|log", "Git operations"],
      ["/work branch:<b>", "Create isolated worktree"],
    ],
  },
  {
    title: "GitHub",
    commands: [
      ["/github status|repo|create|pr|prs", "GitHub via gh CLI"],
    ],
  },
  {
    title: "System",
    commands: [
      ["/status", "Full system status"],
      ["/doctor", "Remote diagnostics"],
      ["/logs lines:<n>", "Recent bot logs"],
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