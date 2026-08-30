import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, ThreadChannel, TextChannel } from "discord.js";
import { getChannelBinding, getThreadSession, loadConfig } from "../storage/index.js";
import { queuePrompt, isBusy } from "../opencode/engine.js";
import * as qs from "../opencode/queue-service.js";
import { Icons } from "../discord/ui.js";
import { truncate } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("opencode")
  .setDescription("Send a prompt to OpenCode")
  .addStringOption((opt) =>
    opt.setName("prompt").setDescription("The prompt to send").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("project").setDescription("Project alias to use").setRequired(false).setAutocomplete(true)
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const prompt = interaction.options.getString("prompt", true);
  const projectOpt = interaction.options.getString("project");

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

  const binding = getChannelBinding(channelId) || (channel instanceof ThreadChannel ? getChannelBinding(channel.id) : null);
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

  const jobId = await queuePrompt({
    prompt,
    title: truncate(prompt, 60),
    channelId,
    threadId: targetThread.id,
    projectAlias,
    sessionId,
  });

  const position = qs.getQueuePosition(jobId);
  const busy = isBusy();
  await interaction.editReply({
    content: busy
      ? position > 0
        ? `${Icons.queued} OpenCode is busy — queued at position **${position}** (job \`${jobId.slice(0, 8)}\`).`
        : `${Icons.queued} Queued (job \`${jobId.slice(0, 8)}\`).`
      : `${Icons.running} Starting (job \`${jobId.slice(0, 8)}\`)…`,
  });
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const config = loadConfig();
  const projects = config?.projects?.registered ?? [];
  const focused = interaction.options.getFocused();
  const choices = projects
    .filter((p) => p.alias.toLowerCase().includes(focused.toLowerCase()))
    .slice(0, 25)
    .map((p) => ({ name: `${p.alias} (${p.path})`, value: p.alias }));
  await interaction.respond(choices);
}
