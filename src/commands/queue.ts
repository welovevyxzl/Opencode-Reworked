import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import * as qs from "../opencode/queue-service.js";
import { cancelJobById, pumpQueue, queueSettings, updateSettings } from "../opencode/engine.js";
import { Icons, jobStatusLine } from "../discord/ui.js";
import { truncate, formatClock } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("Manage the prompt queue")
  .addSubcommand((s) => s.setName("status").setDescription("Show queue status and statistics"))
  .addSubcommand((s) => s.setName("list").setDescription("List queued and running jobs"))
  .addSubcommand((s) => s.setName("pause").setDescription("Pause the queue (running job finishes)"))
  .addSubcommand((s) => s.setName("resume").setDescription("Resume the queue"))
  .addSubcommand((s) =>
    s
      .setName("clear")
      .setDescription("Clear jobs that have not started")
      .addBooleanOption((o) =>
        o
          .setName("include_running")
          .setDescription("Also cancel the currently running job (default false)")
          .setRequired(false)
      )
  )
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Remove an item from the queue")
      .addStringOption((o) => o.setName("id").setDescription("Queue item id").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("settings")
      .setDescription("View or change queue settings")
      .addBooleanOption((o) => o.setName("continue_on_failure").setDescription("Continue to next item after a failure").setRequired(false))
      .addBooleanOption((o) => o.setName("fresh_context").setDescription("Use a fresh context for each queued prompt").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "status") {
    await interaction.deferReply({ ephemeral: true });
    const stats = qs.getQueueStats();
    const active = qs.getActiveJob();
    const lines = [
      `${stats.paused ? "⏸ Paused" : "▶ Active"} · worker \`${stats.workerId}\``,
      `${Icons.running} Active: ${stats.active}${stats.activeJobId ? ` (\`${stats.activeJobId.slice(0, 8)}\`)` : ""}`,
      `${Icons.queued} Queued: ${stats.queued}`,
      `${Icons.ok} Completed: ${stats.completed} · ${Icons.fail} Failed: ${stats.failed} · Cancelled: ${stats.cancelled} · Interrupted: ${stats.interrupted}`,
    ];
    if (active) {
      lines.push("", `Running: \`${active.id.slice(0, 8)}\` — ${truncate(active.prompt, 100)}`);
      if (active.startedAt) lines.push(`Elapsed: ${formatClock(Date.now() - active.startedAt)}`);
    }
    const embed = new EmbedBuilder()
      .setColor(stats.paused ? Colors.Orange : Colors.Blue)
      .setTitle("Queue status")
      .setDescription(lines.join("\n"))
      .setFooter({ text: "OpenCode Remote" });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });
    const active = qs.getActiveJob();
    const queued = qs.getQueuedJobs();
    if (!active && queued.length === 0) {
      await interaction.editReply({ content: "Queue is empty." });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`Queue (${queued.length} waiting${active ? ", 1 running" : ""})`)
      .setFooter({ text: "OpenCode Remote" });
    if (active) {
      embed.addFields({
        name: `${Icons.running} Running · \`${active.id.slice(0, 8)}\``,
        value: `${jobStatusLine(active.status)} · ${truncate(active.prompt, 120)}`,
      });
    }
    queued.forEach((item, index) => {
      embed.addFields({
        name: `${Icons.queued} #${index + 1} · \`${item.id.slice(0, 8)}\``,
        value: truncate(item.prompt, 120),
      });
    });
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "clear") {
    const includeRunning = interaction.options.getBoolean("include_running") ?? false;
    const active = qs.getActiveJob();
    const cleared = qs.clearQueued();
    let runningNote = "";
    if (includeRunning && active) {
      const r = await cancelJobById(active.id);
      runningNote = r.ok ? " Running job cancellation requested." : ` Could not cancel running job: ${r.message}`;
    } else if (!includeRunning && active) {
      runningNote = ` Running job \`${active.id.slice(0, 8)}\` left untouched.`;
    }
    await interaction.reply({
      content: `✓ Cleared **${cleared}** queued job${cleared === 1 ? "" : "s"}.${runningNote}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "remove") {
    const id = interaction.options.getString("id", true).trim();
    const resolved = qs.getJobByShortId(id);
    if (!resolved || "ambiguous" in resolved) {
      await interaction.reply({ content: "No unique queued job found for that id.", ephemeral: true });
      return;
    }
    const r = qs.removeQueuedJob(resolved.id);
    await interaction.reply({
      content: r.ok ? `✓ Removed \`${resolved.id.slice(0, 8)}\` from the queue.` : `Could not remove: ${r.reason}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "pause") {
    if (qs.isPaused()) {
      await interaction.reply({ content: "Queue is already paused.", ephemeral: true });
      return;
    }
    qs.setPaused(true);
    const active = qs.getActiveJob();
    await interaction.reply({
      content: `⏸ Queue paused. ${active ? `The running job (\`${active.id.slice(0, 8)}\`) will finish; no new jobs start until \`/queue resume\`.` : "No new jobs will start until `/queue resume`."}`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "resume") {
    if (!qs.isPaused()) {
      await interaction.reply({ content: "Queue is not paused.", ephemeral: true });
      return;
    }
    qs.setPaused(false);
    void pumpQueue();
    await interaction.reply({ content: "✓ Queue resumed. Jobs will continue processing.", ephemeral: true });
    return;
  }

  if (sub === "settings") {
    const cont = interaction.options.getBoolean("continue_on_failure");
    const fresh = interaction.options.getBoolean("fresh_context");
    if (cont !== null || fresh !== null) {
      await updateSettings({
        continueOnFailure: cont ?? undefined,
        freshContext: fresh ?? undefined,
      });
      const s = queueSettings();
      await interaction.reply({
        content: `✓ Settings updated — continue on failure: **${s.continueOnFailure ? "on" : "off"}**, fresh context: **${s.freshContext ? "on" : "off"}**.`,
        ephemeral: true,
      });
    } else {
      const s = queueSettings();
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Blue)
            .setTitle("Queue settings")
            .addFields(
              { name: "Continue on failure", value: s.continueOnFailure ? "✓ enabled — next job starts after a failure" : "disabled — queue pauses after a failure", inline: false },
              { name: "Fresh context", value: s.freshContext ? "✓ enabled — every prompt gets a new session" : "disabled — threads keep their session", inline: false },
              { name: "Paused", value: qs.isPaused() ? "⏸ paused" : "active", inline: true }
            )
            .setFooter({ text: "OpenCode Remote" }),
        ],
        ephemeral: true,
      });
    }
  }
}
