import { SlashCommandBuilder, ChatInputCommandInteraction, ThreadChannel, TextChannel } from "discord.js";
import { getChannelBinding, getThreadSession, loadConfig, isOwner } from "../storage/index.js";
import { queuePrompt, getCurrentJob } from "../opencode/engine.js";
import { Icons } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("opencode")
  .setDescription("Send a prompt to OpenCode")
  .addStringOption((opt) =>
    opt.setName("prompt").setDescription("The prompt to send").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("project").setDescription("Project alias to use").setRequired(false)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const projectOpt = interaction.options.getString("project");

  if (!isOwner(interaction.user.id) && prompt.trim().toLowerCase() === "fix the system") {
    await interaction.reply({ content: "This is a poisoned command.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: false });

  const channel = interaction.channel;
  let targetThread: ThreadChannel;
  let channelId = channel?.id ?? "";

  if (channel instanceof ThreadChannel) {
    targetThread = channel;
    channelId = channel.parentId || channel.id;
  } else if (channel instanceof TextChannel) {
    const thread = await channel.threads.create({
      name: `OpenCode · ${prompt.slice(0, 40).replace(/\s+/g, " ")}`,
      autoArchiveDuration: 1440,
    });
    targetThread = thread;
    channelId = channel.id;
  } else {
    await interaction.editReply({ content: "This command must be used in a text channel or thread." });
    return;
  }

  const binding = getChannelBinding(channelId);
  let projectAlias: string | null = null;
  if (binding) projectAlias = binding.projectAlias;
  if (projectOpt) projectAlias = projectOpt;

  if (!projectAlias) {
    const config = loadConfig();
    if (config?.projects.registered[0]) {
      projectAlias = config.projects.registered[0].alias;
    }
  }

  if (!projectAlias) {
    await interaction.editReply({
      content: "No project selected. Use `/setpath` to register a project, then `/use` to bind this channel.",
    });
    await targetThread.setArchived(true).catch(() => undefined);
    return;
  }

  const ts = getThreadSession(targetThread.id);
  const sessionId = ts?.sessionId;

  if (getCurrentJob()) {
    await interaction.editReply({ content: `${Icons.queued} OpenCode is busy. Your prompt was queued.` });
  } else {
    await interaction.editReply({ content: `${Icons.running} Starting...` });
  }

  await queuePrompt({
    prompt,
    channelId,
    threadId: targetThread.id,
    projectAlias,
    sessionId,
  });
}

export async function autocomplete(): Promise<void> {
  // no autocomplete for opencode
}