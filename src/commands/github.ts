import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getChannelBinding, getProjectState } from "../storage/index.js";
import * as gh from "../github/index.js";
import * as git from "../git/index.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("github")
  .setDescription("GitHub integration via gh CLI (operates on the bound project)")
  .addSubcommand((s) => s.setName("status").setDescription("Show GitHub auth status"))
  .addSubcommand((s) => s.setName("repo").setDescription("Show the repository for the bound project"))
  .addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Create a GitHub repository from the bound project")
      .addStringOption((o) => o.setName("name").setDescription("Repo name").setRequired(true))
      .addStringOption((o) => o.setName("visibility").setDescription("Visibility").setRequired(false).addChoices({ name: "private", value: "private" }, { name: "public", value: "public" }))
      .addBooleanOption((o) => o.setName("commit").setDescription("Create initial commit").setRequired(false))
  )
  .addSubcommand((s) =>
    s
      .setName("pr")
      .setDescription("Create a pull request in the bound project")
      .addStringOption((o) => o.setName("title").setDescription("PR title").setRequired(true))
      .addStringOption((o) => o.setName("body").setDescription("PR body").setRequired(false))
      .addStringOption((o) => o.setName("base").setDescription("Base branch").setRequired(false))
  )
  .addSubcommand((s) => s.setName("prs").setDescription("List pull requests for the bound project"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "status":
      await ghStatus(interaction);
      break;
    case "repo":
      await ghRepo(interaction);
      break;
    case "create":
      await ghCreate(interaction);
      break;
    case "pr":
      await ghPr(interaction);
      break;
    case "prs":
      await ghPrs(interaction);
      break;
  }
}

async function ghStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const res = await gh.authStatus();
  const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle("GitHub").setFooter({ text: "OpenCode Remote" });
  embed.addFields({ name: "Auth", value: res.authenticated ? `${Icons.ok} authenticated as **${res.user}**` : `${Icons.fail} ${res.error || "not authenticated"}` });
  await interaction.editReply({ embeds: [embed] });
}

async function ghRepo(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const path = await projectPath(interaction);
  if (!path) return;
  const res = await gh.getRepoInfo(path);
  const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle("GitHub repo").setFooter({ text: "OpenCode Remote" });
  if (res.ok && res.repo) {
    embed.addFields(
      { name: "Repository", value: `${res.repo.owner}/${res.repo.name}` },
      { name: "URL", value: res.repo.url }
    );
  } else {
    embed.addFields({ name: "Repository", value: res.error || "not a GitHub repo" });
  }
  await interaction.editReply({ embeds: [embed] });
}

async function ghCreate(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString("name", true);
  const visibility = interaction.options.getString("visibility") as "private" | "public" | null || "private";
  const commit = interaction.options.getBoolean("commit") ?? false;

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

  await interaction.deferReply();

  let inited = await git.isGitRepo(state.path);
  if (!inited) {
    const res = await git.initRepo(state.path);
    if (!res.ok) {
      await interaction.editReply({ content: `${Icons.fail} Could not init git: ${res.error}` });
      return;
    }
    inited = true;
  }

  if (commit) {
    await git.initGitIgnore(state.path);
    const add = await git.stageAll(state.path);
    if (!add.ok) {
      await interaction.editReply({ content: `${Icons.fail} Failed to stage: ${add.error}` });
      return;
    }
    const cc = await git.commit(state.path, `Initial commit`);
    if (!cc.ok) {
      await interaction.editReply({ content: `${Icons.fail} Initial commit failed (maybe nothing to commit): ${cc.error}` });
      return;
    }
  }

  // createRepo now receives the project directory explicitly — no cwd reliance.
  const create = await gh.createRepo(state.path, name, { visibility });
  if (!create.ok) {
    await interaction.editReply({ content: `${Icons.fail} ${create.error}` });
    return;
  }

  const setOrigin = await git.addRemote(state.path, create.url || `https://github.com/${name}.git`);
  if (!setOrigin.ok) {
    await interaction.editReply({ content: `${Icons.fail} Repo created but could not set origin: ${setOrigin.error}` });
    return;
  }

  const branch = await git.getCurrentBranch(state.path);
  const push = await git.push(state.path, "origin", branch);
  if (!push.ok) {
    await interaction.editReply({ content: `${Icons.fail} Repo created at ${create.url} but push failed: ${push.error}` });
    return;
  }

  await interaction.editReply({ content: `${Icons.ok} Created and pushed **${name}** (${visibility}) at ${create.url}` });
}

async function ghPr(interaction: ChatInputCommandInteraction): Promise<void> {
  const title = interaction.options.getString("title", true);
  const body = interaction.options.getString("body") ?? undefined;
  const base = interaction.options.getString("base") ?? undefined;
  await interaction.deferReply();
  const path = await projectPath(interaction);
  if (!path) return;
  const branch = await git.getCurrentBranch(path);
  const res = await gh.createPullRequest(path, { title, body, base, head: branch });
  if (!res.ok) {
    await interaction.editReply({ content: `${Icons.fail} ${res.error}` });
    return;
  }
  await interaction.editReply({ content: `${Icons.ok} PR created: ${res.url || title}` });
}

async function ghPrs(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();
  const path = await projectPath(interaction);
  if (!path) return;
  const prs = await gh.listPullRequests(path);
  if (prs.length === 0) {
    await interaction.editReply({ content: "No open PRs." });
    return;
  }
  const embed = new EmbedBuilder().setColor(Colors.Blue).setTitle(`Pull requests (${prs.length})`).setFooter({ text: "OpenCode Remote" });
  embed.setDescription(prs.slice(0, 15).map((p) => `#${p.number} **${p.title}**\n${p.url}`).join("\n\n"));
  await interaction.editReply({ embeds: [embed] });
}

async function projectPath(interaction: ChatInputCommandInteraction): Promise<string | null> {
  const binding = getChannelBinding(interaction.channelId);
  if (!binding) {
    await interaction.editReply({ content: "No project bound. Use `/use`." });
    return null;
  }
  const state = getProjectState(binding.projectAlias);
  if (!state?.path) {
    await interaction.editReply({ content: `Project \`${binding.projectAlias}\` not found.` });
    return null;
  }
  return state.path;
}
