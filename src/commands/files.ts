import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getChannelBinding, getProjectState } from "../storage/index.js";
import { readdir, readFile, stat } from "fs/promises";
import { resolve, relative } from "path";
import { Icons } from "../discord/ui.js";

const SECRET_FILENAMES = [".env", ".env.local", "credentials", "credentials.json", ".netrc", "id_rsa", "id_ed25519", "id_ecdsa", "*.pem", "*.key", "token", "tokens", "secret", "secrets", ".npmrc", ".git-credentials"];

function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (SECRET_FILENAMES.some((s) => lower === s.toLowerCase() || (s.startsWith("*") && lower.endsWith(s.slice(1))))) return true;
  if (lower.includes(".ssh")) return true;
  if (lower.startsWith(".env")) return true;
  return false;
}

export const data = new SlashCommandBuilder()
  .setName("files")
  .setDescription("Browse files in the bound project")
  .addSubcommand((s) => s.setName("list").setDescription("List files in a directory").addStringOption((o) => o.setName("path").setDescription("Relative path").setRequired(false)).addIntegerOption((o) => o.setName("depth").setDescription("Max depth").setRequired(false)))
  .addSubcommand((s) => s.setName("read").setDescription("Read a file").addStringOption((o) => o.setName("path").setDescription("Relative path").setRequired(true)));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const binding = getChannelBinding(interaction.channelId);
  if (!binding) {
    await interaction.reply({ content: "No project bound. Use `/use`.", ephemeral: true });
    return;
  }
  const state = getProjectState(binding.projectAlias);
  if (!state?.path) {
    await interaction.reply({ content: `Project \`${binding.projectAlias}\` not found.`, ephemeral: true });
    return;
  }
  const root = resolve(state.path);

  if (sub === "list") {
    await doList(interaction, root);
  } else if (sub === "read") {
    await doRead(interaction, root);
  }
}

function safeResolve(root: string, rel: string): string | null {
  const target = resolve(root, rel);
  const relToRoot = relative(root, target);
  if (relToRoot.startsWith("..") || resolve(root, relToRoot) !== target) {
    return null;
  }
  return target;
}

async function doList(interaction: ChatInputCommandInteraction, root: string): Promise<void> {
  const rel = interaction.options.getString("path") ?? ".";
  const target = safeResolve(root, rel);
  if (!target) {
    await interaction.reply({ content: `${Icons.fail} Path escapes the project root.`, ephemeral: true });
    return;
  }
  await interaction.deferReply();
  let entries;
  try {
    const st = await stat(target);
    if (!st.isDirectory()) {
      await interaction.editReply({ content: `\`${rel}\` is not a directory.` });
      return;
    }
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    await interaction.editReply({ content: `${Icons.fail} Could not read \`${rel}\`.` });
    return;
  }

  const files = entries.filter((e) => e.isFile() && !e.name.startsWith(".") && !isSecretFile(e.name));
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`📁 ${rel || "."}`)
    .setFooter({ text: "OpenCode Remote · hidden and secret files are excluded" })
    .setDescription(
      `**Directories:**\n${dirs.map((d) => `\`${d.name}/\``).join(" ") || "(none)"}\n\n**Files:**\n${files.map((f) => `\`${f.name}\``).join(" ") || "(none)"}`
    );
  await interaction.editReply({ embeds: [embed] });
}

async function doRead(interaction: ChatInputCommandInteraction, root: string): Promise<void> {
  const rel = interaction.options.getString("path", true);
  const target = safeResolve(root, rel);
  if (!target) {
    await interaction.reply({ content: `${Icons.fail} Path escapes the project root.`, ephemeral: true });
    return;
  }
  if (isSecretFile(relative(root, target))) {
    await interaction.reply({ content: `${Icons.fail} That file is off-limits (potential secret).`, ephemeral: true });
    return;
  }
  await interaction.deferReply();
  let content: string;
  let size: number;
  try {
    const st = await stat(target);
    if (st.isDirectory()) {
      await interaction.editReply({ content: `\`${rel}\` is a directory. Use /files list.` });
      return;
    }
    size = st.size;
    if (size > 500_000) {
      await interaction.editReply({ content: `${Icons.fail} File is ${(size / 1024).toFixed(0)} KB — too large to display. Use /files for smaller files.` });
      return;
    }
    content = await readFile(target, "utf-8");
  } catch {
    await interaction.editReply({ content: `${Icons.fail} Could not read \`${rel}\`.` });
    return;
  }

  const snippet = content.slice(0, 3500);
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`File: ${relative(root, target)}`)
    .setFooter({ text: `OpenCode Remote · ${(size / 1024).toFixed(1)} KB${content.length > snippet.length ? " · truncated" : ""}` })
    .setDescription("```\n" + snippet + (content.length > snippet.length ? "\n…" : "") + "\n```");
  await interaction.editReply({ embeds: [embed] });
}