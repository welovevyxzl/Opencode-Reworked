import {
  EmbedBuilder,
  Colors,
  type Message,
} from "discord.js";

export const Icons = {
  running: "●",
  idle: "○",
  ok: "✓",
  fail: "×",
  queued: "◌",
};

export function baseEmbed(color: number = Colors.Blue): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(color)
    .setFooter({ text: "OpenCode Remote" });
}

export function successEmbed(title: string, description = ""): EmbedBuilder {
  return baseEmbed(Colors.Green).setTitle(`${Icons.ok} ${title}`).setDescription(description);
}

export function errorEmbed(title: string, description = "") {
  return baseEmbed(Colors.Red).setTitle(`${Icons.fail} ${title}`).setDescription(description);
}

export function progressEmbed(title = "Working") {
  return baseEmbed(Colors.Blue).setTitle(`${Icons.running} ${title}`);
}

export function infoEmbed(title: string, description = "") {
  return baseEmbed(Colors.Blue).setTitle(title).setDescription(description);
}

export function fieldValue(icon: string, value: string): string {
  return `${icon} ${value}`;
}

export function makeDiffEmbed(diff: string) {
  const lines = diff.split("\n");
  const kept = lines.slice(0, 30).join("\n");
  const truncated = lines.length > 30;
  const embed = baseEmbed(0x2f3136)
    .setTitle("Git Diff")
    .addFields({ name: "Files changed", value: `${lines.filter((l) => l.startsWith("diff --git")).length}`, inline: true })
    .addFields({ name: "Lines", value: `+${lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).length} -${lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).length}`, inline: true })
    .setDescription("```diff\n" + (kept.length > 1800 ? kept.slice(0, 1800) : kept) + "\n```");
  if (truncated) {
    embed.setFooter({ text: `Truncated. Full diff attached as file.` });
  }
  return embed;
}

export function formatQueueStatus(item: { status: string }, position: number): string {
  switch (item.status) {
    case "running":
      return `${Icons.running} **Running**`;
    case "completed":
      return `${Icons.ok} Completed`;
    case "failed":
      return `${Icons.fail} Failed`;
    default:
      return `${Icons.queued} Position ${position}`;
  }
}

export function sendMessage(channel: { send: (arg0: unknown) => Promise<Message> }, content: unknown): Promise<Message> {
  return channel.send(content as never);
}