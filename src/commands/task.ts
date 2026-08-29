import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors, ThreadChannel, TextChannel } from "discord.js";
import { getRecentTasks, getActiveTasks, getTask } from "../storage/index.js";
import { createTask, cancelTask, resumeTask } from "../opencode/task-runner.js";
import { DEFAULT_MAX_ITERATIONS, parseTaskState } from "../opencode/task-logic.js";
import { Icons } from "../discord/ui.js";
import { truncate, formatDuration } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("task")
  .setDescription("Run a tracked task with optional autopilot mode")
  .addSubcommand((s) =>
    s
      .setName("start")
      .setDescription("Start a task")
      .addStringOption((o) => o.setName("prompt").setDescription("What should be done").setRequired(true))
      .addStringOption((o) => o.setName("project").setDescription("Project alias").setRequired(false).setAutocomplete(true))
      .addStringOption((o) =>
        o
          .setName("mode")
          .setDescription("Task mode")
          .setRequired(false)
          .addChoices({ name: "normal — single pass, still tracked", value: "normal" }, { name: "autopilot — iterate until done", value: "autopilot" })
      )
      .addIntegerOption((o) => o.setName("max_iterations").setDescription("Autopilot iteration cap (default 10)").setRequired(false).setMinValue(1).setMaxValue(25))
  )
  .addSubcommand((s) =>
    s
      .setName("status")
      .setDescription("Show task status")
      .addStringOption((o) => o.setName("id").setDescription("Task id (short form works; defaults to newest)").setRequired(false))
  )
  .addSubcommand((s) =>
    s
      .setName("stop")
      .setDescription("Cancel a running task")
      .addStringOption((o) => o.setName("id").setDescription("Task id").setRequired(false))
  )
  .addSubcommand((s) =>
    s
      .setName("resume")
      .setDescription("Resume a paused task")
      .addStringOption((o) => o.setName("id").setDescription("Task id").setRequired(true))
  )
  .addSubcommand((s) => s.setName("list").setDescription("List recent tasks"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "start") {
    const prompt = interaction.options.getString("prompt", true);
    const projectOpt = interaction.options.getString("project");
    const mode = (interaction.options.getString("mode") as "normal" | "autopilot" | null) ?? "normal";
    const maxIterations = interaction.options.getInteger("max_iterations") ?? DEFAULT_MAX_ITERATIONS;

    await interaction.deferReply({ ephemeral: false });

    const channel = interaction.channel;
    let thread: ThreadChannel | null = null;
    let channelId = channel?.id ?? "";
    if (channel instanceof ThreadChannel) {
      thread = channel;
      channelId = channel.parentId || channel.id;
    } else if (channel instanceof TextChannel) {
      thread = await channel.threads.create({
        name: `Task · ${prompt.slice(0, 40).replace(/\s+/g, " ")}`,
        autoArchiveDuration: 1440,
      });
      channelId = channel.id;
    }

    const { getChannelBinding, loadConfig } = await import("../storage/index.js");
    const binding = getChannelBinding(channelId);
    let projectAlias = projectOpt || binding?.projectAlias || null;
    if (!projectAlias) {
      const config = loadConfig();
      if (config?.projects.registered[0]) projectAlias = config.projects.registered[0].alias;
    }
    if (!projectAlias) {
      await interaction.editReply({ content: "No project selected. Use `/setpath` and `/use` first." });
      return;
    }

    const { getThreadSession } = await import("../storage/index.js");
    const sessionId = thread ? getThreadSession(thread.id)?.sessionId : undefined;

    const task = await createTask({
      prompt,
      projectAlias,
      channelId,
      threadId: thread?.id,
      sessionId,
      mode,
      maxIterations,
    });

    await interaction.editReply({
      content: thread
        ? `${Icons.running} Task \`${task.id.slice(5, 10)}\` started in ${mode} mode — iterate until done, verification enforced.`
        : `${Icons.running} Task \`${task.id.slice(5, 10)}\` started in ${mode} mode.`,
    });
    return;
  }

  if (sub === "status") {
    const idInput = interaction.options.getString("id");
    const task = await findTask(idInput);
    if (!task) {
      await interaction.reply({ content: "Task not found.", ephemeral: true });
      return;
    }
    const state = parseTaskState(task.stateJson);
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`Task \`${task.id.slice(5, 10)}\` · ${task.mode}`)
      .setDescription(truncate(task.prompt, 300))
      .addFields(
        { name: "Status", value: task.status, inline: true },
        { name: "Iteration", value: `${task.iteration}/${task.maxIterations}`, inline: true },
        { name: "Project", value: `\`${task.projectAlias}\``, inline: true },
        {
          name: "Last verification",
          value: state.lastVerification ? `${state.lastVerification.summary} (<t:${Math.floor(state.lastVerification.at / 1000)}:R>)` : "not run yet",
          inline: false,
        },
        {
          name: "Remaining work",
          value: state.remainingWork.length > 0 ? state.remainingWork.map((r) => `• ${truncate(r, 150)}`).join("\n") : "—",
          inline: false,
        }
      )
      .setFooter({ text: `full id: ${task.id}` });
    await interaction.reply({ embeds: [embed], ephemeral: true });
    return;
  }

  if (sub === "stop") {
    const idInput = interaction.options.getString("id");
    const task = await findTask(idInput);
    if (!task) {
      await interaction.reply({ content: "Task not found.", ephemeral: true });
      return;
    }
    const r = await cancelTask(task.id);
    await interaction.reply({ content: r.ok ? `✓ ${r.message}` : r.message, ephemeral: true });
    return;
  }

  if (sub === "resume") {
    const idInput = interaction.options.getString("id", true);
    const task = await findTask(idInput);
    if (!task) {
      await interaction.reply({ content: "Task not found.", ephemeral: true });
      return;
    }
    const r = await resumeTask(task.id);
    await interaction.reply({ content: r.ok ? `✓ ${r.message}` : r.message, ephemeral: true });
    return;
  }

  if (sub === "list") {
    const tasks = [...getActiveTasks(), ...getRecentTasks(10)].filter(
      (t, i, arr) => arr.findIndex((x) => x.id === t.id) === i
    );
    if (tasks.length === 0) {
      await interaction.reply({ content: "No tasks yet. Start one with `/task start`.", ephemeral: true });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`Tasks (${tasks.length})`)
      .setDescription(
        tasks
          .slice(0, 12)
          .map(
            (t) =>
              `\`${t.id.slice(5, 10)}\` · ${t.status} · iter ${t.iteration}/${t.maxIterations} · ${truncate(t.prompt, 60)} · ${formatDuration(Date.now() - t.updatedAt)} ago`
          )
          .join("\n")
          .slice(0, 3900)
      )
      .setFooter({ text: "OpenCode Remote" });
    await interaction.reply({ embeds: [embed], ephemeral: true });
  }
}

async function findTask(idInput: string | null) {
  if (!idInput) return getRecentTasks(1)[0] ?? null;
  const normalized = idInput.startsWith("task-") ? idInput : `task-${idInput}`;
  const exact = getTask(normalized);
  if (exact) return exact;
  const prefix = getRecentTasks(50).find((t) => t.id.startsWith(normalized));
  return prefix ?? null;
}

export async function autocomplete(interaction: import("discord.js").AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== "task") return;
  const { loadConfig } = await import("../storage/index.js");
  const config = loadConfig();
  const projects = config?.projects?.registered ?? [];
  const focused = interaction.options.getFocused();
  await interaction.respond(
    projects
      .filter((p) => p.alias.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25)
      .map((p) => ({ name: `${p.alias} (${p.path})`, value: p.alias }))
  );
}
