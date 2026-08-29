import { randomBytes } from "crypto";
import { SlashCommandBuilder, ChatInputCommandInteraction, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Colors } from "discord.js";
import { getChannelBinding, getProjectState, savePendingAction } from "../storage/index.js";
import * as git from "../git/index.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("git")
  .setDescription("Run Git operations on the bound project")
  .addSubcommand((s) => s.setName("status").setDescription("Show Git status"))
  .addSubcommand((s) => s.setName("branch").setDescription("List branches"))
  .addSubcommand((s) => s.setName("checkout").setDescription("Checkout a branch").addStringOption((o) => o.setName("branch").setDescription("Branch name").setRequired(true)))
  .addSubcommand((s) => s.setName("pull").setDescription("Pull from remote"))
  .addSubcommand((s) => s.setName("push").setDescription("Push to remote"))
  .addSubcommand((s) => s.setName("commit").setDescription("Commit changes (confirmed via button)").addStringOption((o) => o.setName("message").setDescription("Commit message").setRequired(true)))
  .addSubcommand((s) => s.setName("log").setDescription("Show recent commits").addIntegerOption((o) => o.setName("count").setDescription("Number of commits").setRequired(false)));

const COMMIT_CONFIRM_TIMEOUT = 10 * 60_000; // commits can wait longer than PC actions

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const binding = getChannelBinding(interaction.channelId);
  if (!binding) {
    await interaction.reply({ content: "No project bound. Use `/use`.", ephemeral: true });
    return;
  }
  const state = getProjectState(binding.projectAlias);
  if (!state || !state.path) {
    await interaction.reply({ content: `Project \`${binding.projectAlias}\` not found.`, ephemeral: true });
    return;
  }
  const path = state.path;

  switch (sub) {
    case "status":
      await doStatus(interaction, path);
      break;
    case "branch":
      await doBranch(interaction, path);
      break;
    case "checkout":
      await doCheckout(interaction, path);
      break;
    case "pull":
      await doPull(interaction, path);
      break;
    case "push":
      await doPush(interaction, path);
      break;
    case "commit":
      await doCommit(interaction, path);
      break;
    case "log":
      await doLog(interaction, path);
      break;
  }
}

async function doStatus(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  await interaction.deferReply();
  const status = await git.getStatus(path);
  if (!status) {
    await interaction.editReply({ content: `${Icons.fail} Not a Git repository.` });
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle(`Git status · ${status.branch}`)
    .setFooter({ text: "OpenCode Remote" })
    .addFields(
      { name: "Clean", value: status.clean ? `${Icons.ok} clean` : "changes", inline: true },
      { name: "Ahead/Behind", value: `${status.ahead}/${status.behind}`, inline: true },
      { name: "Staged", value: status.staged.length ? status.staged.slice(0, 10).map((f) => `\`${f}\``).join("\n") : "—", inline: true },
      { name: "Modified", value: status.modified.length ? status.modified.slice(0, 10).map((f) => `\`${f}\``).join("\n") : "—", inline: true },
      { name: "Untracked", value: status.untracked.length ? status.untracked.slice(0, 10).map((f) => `\`${f}\``).join("\n") : "—", inline: true }
    );
  await interaction.editReply({ embeds: [embed] });
}

async function doBranch(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  await interaction.deferReply();
  const branches = await git.listBranches(path);
  const current = await git.getCurrentBranch(path);
  const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle("Branches").setFooter({ text: "OpenCode Remote" });
  embed.setDescription(branches.map((b) => (b === current ? `${Icons.running} ${b}` : b)).join("\n") || "(none)");
  await interaction.editReply({ embeds: [embed] });
}

async function doCheckout(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  const branch = interaction.options.getString("branch", true);
  // Reject branch names that could be interpreted as git options/revisions.
  if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(branch) || branch.startsWith("-")) {
    await interaction.reply({ content: `${Icons.fail} Invalid branch name.`, ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const res = await git.checkoutBranch(path, branch);
  if (!res.ok) {
    await interaction.editReply({ content: `${Icons.fail} ${res.error}` });
    return;
  }
  await interaction.editReply({ content: `✓ Checked out \`${branch}\`.` });
}

async function doPull(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  await interaction.deferReply();
  const res = await git.pull(path);
  if (!res.ok) {
    await interaction.editReply({ content: `${Icons.fail} ${res.error}` });
    return;
  }
  await interaction.editReply({ content: `${Icons.ok} Pull succeeded.` });
}

async function doPush(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  await interaction.deferReply();
  const branch = await git.getCurrentBranch(path);
  const res = await git.push(path, "origin", branch);
  if (!res.ok) {
    await interaction.editReply({ content: `${Icons.fail} ${res.error}` });
    return;
  }
  await interaction.editReply({ content: `${Icons.ok} Pushed \`${branch}\`.` });
}

async function doCommit(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  const message = interaction.options.getString("message", true);
  if (/[\r\n]/.test(message) || message.length > 200) {
    await interaction.reply({ content: "Message must be a single line, max 200 chars.", ephemeral: true });
    return;
  }
  await interaction.deferReply();
  const status = await git.getStatus(path);
  if (!status) {
    await interaction.editReply({ content: `${Icons.fail} Not a Git repository.` });
    return;
  }
  if (status.staged.length === 0 && status.modified.length === 0 && status.untracked.length === 0) {
    await interaction.editReply({ content: "Nothing to commit." });
    return;
  }

  // Durable confirmation in SQLite: survives restarts, single-use, requester-bound.
  const key = randomBytes(16).toString("hex");
  savePendingAction({
    id: key,
    type: "git:commit",
    channelId: interaction.channelId,
    projectAlias: (await import("../storage/index.js")).getChannelBinding(interaction.channelId)?.projectAlias,
    payloadJson: JSON.stringify({ message }),
    requesterId: interaction.user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + COMMIT_CONFIRM_TIMEOUT,
  });

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setTitle("Will commit")
    .setFooter({ text: `OpenCode Remote · confirm within 10 min · msg: ${message.slice(0, 60)}` })
    .setDescription(
      `**Staged:**\n${status.staged.map((f) => `\`${f}\``).join("\n") || "(none)"}\n\n` +
        `**Modified (not staged):**\n${status.modified.map((f) => `\`${f}\``).join("\n") || "(none)"}\n\n` +
        `**Untracked:**\n${status.untracked.map((f) => `\`${f}\``).join("\n") || "(none)"}`
    );

  const confirm = new ButtonBuilder().setCustomId(`gc_commit_${key}`).setLabel("Stage all & commit").setStyle(ButtonStyle.Primary);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm);
  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function doLog(interaction: ChatInputCommandInteraction, path: string): Promise<void> {
  const count = Math.min(interaction.options.getInteger("count") ?? 10, 20);
  await interaction.deferReply();
  const commits = await git.log(path, count);
  if (commits.length === 0) {
    await interaction.editReply({ content: "No commits." });
    return;
  }
  const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle(`Recent commits (${commits.length})`).setFooter({ text: "OpenCode Remote" });
  embed.setDescription(commits.map((c) => `\`${c.hash}\` **${c.message.slice(0, 80)}**\n${c.author} · ${c.date}`).join("\n\n"));
  await interaction.editReply({ embeds: [embed] });
}
