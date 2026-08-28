import { SlashCommandBuilder, ChatInputCommandInteraction, ThreadChannel, TextChannel, ButtonStyle, ButtonBuilder, ActionRowBuilder } from "discord.js";
import { getChannelBinding, getProjectState, saveThreadSession } from "../storage/index.js";
import { createWorktree, getCurrentBranch } from "../git/index.js";
import * as oc from "../opencode/manager.js";

export const data = new SlashCommandBuilder()
  .setName("work")
  .setDescription("Create an isolated Git worktree with a Discord thread")
  .addStringOption((o) => o.setName("branch").setDescription("Branch name").setRequired(true))
  .addStringOption((o) => o.setName("description").setDescription("Short description used as directory name").setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const branch = interaction.options.getString("branch", true);
  const description = interaction.options.getString("description") || branch;

  if (!/^[a-zA-Z0-9._/-]{1,120}$/.test(branch)) {
    await interaction.reply({ content: "Invalid branch name.", ephemeral: true });
    return;
  }

  const binding = getChannelBinding(interaction.channelId);
  if (!binding) {
    await interaction.reply({ content: "No project bound. Use `/use` first.", ephemeral: true });
    return;
  }
  const state = getProjectState(binding.projectAlias);
  if (!state || !state.path) {
    await interaction.reply({ content: `Project \`${binding.projectAlias}\` not found.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const currentBranch = await getCurrentBranch(state.path);
  if (branch === currentBranch) {
    await interaction.editReply({ content: `Branch \`${branch}\` is already checked out.` });
    return;
  }

  const created = await createWorktree(state.path, branch, description);
  if (!created.ok) {
    await interaction.editReply({ content: `Failed to create worktree: ${created.error}` });
    return;
  }

  const wtPath = created.path!;
  const session = await oc.createSession(`Worktree ${branch}`);
  if (!session) {
    await interaction.editReply({ content: `Worktree created at \`${wtPath}\` but OpenCode session failed.` });
    return;
  }

  const parent = interaction.channel;
  let thread: ThreadChannel | null = null;
  if (parent instanceof TextChannel) {
    thread = await parent.threads.create({
      name: `work ${branch}`.slice(0, 100),
      autoArchiveDuration: 1440,
    });
  } else if (parent instanceof ThreadChannel) {
    thread = parent;
  }

  saveThreadSession(thread?.id || interaction.channelId, session.id, binding.projectAlias, interaction.channelId);

  const viewDiff = new ButtonBuilder().setCustomId("wb_diff").setLabel("View Diff").setStyle(ButtonStyle.Secondary);
  const commit = new ButtonBuilder().setCustomId("wb_commit").setLabel("Commit").setStyle(ButtonStyle.Primary);
  const push = new ButtonBuilder().setCustomId("wb_push").setLabel("Push").setStyle(ButtonStyle.Secondary);
  const pr = new ButtonBuilder().setCustomId("wb_pr").setLabel("Create PR").setStyle(ButtonStyle.Success);
  const del = new ButtonBuilder().setCustomId("wb_delete").setLabel("Delete Worktree").setStyle(ButtonStyle.Danger);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(viewDiff, commit, push, pr, del);

  await interaction.editReply({
    content:
      `✓ Worktree \`${branch}\` created at \`${wtPath}\`\n` +
      (thread ? `Thread created: ${thread}\n` : "") +
      `Session attached: \`${session.id.slice(0, 8)}\`\n\n` +
      `Use \`/use project:${binding.projectAlias}\` and set the path to the worktree, or run worktree actions below.`,
    components: [row],
  });
}