import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import * as qs from "../opencode/queue-service.js";
import { cancelJobById, getActiveJobView, pumpQueue } from "../opencode/engine.js";
import { jobStatusColor, jobStatusLine, Icons } from "../discord/ui.js";
import { formatClock, truncate } from "../utils/index.js";
import type { QueueItem } from "../types/index.js";

export const data = new SlashCommandBuilder()
  .setName("job")
  .setDescription("Inspect and manage jobs")
  .addSubcommand((s) => s.setName("current").setDescription("Show the currently running job"))
  .addSubcommand((s) =>
    s
      .setName("info")
      .setDescription("Show details for a job")
      .addStringOption((o) => o.setName("id").setDescription("Job id (short form works)").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("retry")
      .setDescription("Re-queue a finished/failed job")
      .addStringOption((o) => o.setName("id").setDescription("Job id").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("cancel")
      .setDescription("Cancel a queued or running job")
      .addStringOption((o) => o.setName("id").setDescription("Job id").setRequired(true))
  )
  .addSubcommand((s) => s.setName("list").setDescription("List recent jobs"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (sub === "current") {
    const view = getActiveJobView();
    if (!view) {
      const stats = qs.getQueueStats();
      await interaction.editReply({
        content:
          stats.paused
            ? `No job running. Queue is **paused** with ${stats.queued} waiting.`
            : `No job running. ${stats.queued} waiting in queue.`,
      });
      return;
    }
    await interaction.editReply({ embeds: [jobEmbed(view.job, { elapsedMs: view.elapsedMs, statusLine: jobStatusLine(view.job.status), currentAction: view.currentAction })] });
    return;
  }

  if (sub === "info") {
    const idInput = interaction.options.getString("id", true).trim();
    const resolved = qs.getJobByShortId(idInput);
    if (!resolved) {
      await interaction.editReply({ content: "No job found for that id." });
      return;
    }
    if ("ambiguous" in resolved) {
      await interaction.editReply({
        content: `Ambiguous short id. Matching jobs: ${resolved.matches.map((m) => `\`${m.slice(0, 12)}\``).join(", ")}. Use more characters.`,
      });
      return;
    }
    await interaction.editReply({ embeds: [jobEmbed(resolved, { position: qs.getQueuePosition(resolved.id) })] });
    return;
  }

  if (sub === "retry") {
    const idInput = interaction.options.getString("id", true).trim();
    const resolved = qs.getJobByShortId(idInput);
    if (!resolved || "ambiguous" in resolved) {
      await interaction.editReply({ content: "No unique job found for that id." });
      return;
    }
    const r = qs.retryJob(resolved.id);
    if (!r.ok) {
      await interaction.editReply({ content: `Could not retry: ${r.reason}` });
      return;
    }
    void pumpQueue();
    await interaction.editReply({ content: `✓ Job \`${resolved.id.slice(0, 8)}\` re-queued.` });
    return;
  }

  if (sub === "cancel") {
    const idInput = interaction.options.getString("id", true).trim();
    const resolved = qs.getJobByShortId(idInput);
    if (!resolved || "ambiguous" in resolved) {
      await interaction.editReply({ content: "No unique job found for that id." });
      return;
    }
    const r = await cancelJobById(resolved.id);
    await interaction.editReply({ content: r.ok ? `✓ ${r.message}` : `${r.message}` });
    return;
  }

  if (sub === "list") {
    const { getRecentFinishedQueue } = await import("../storage/index.js");
    const recent = getRecentFinishedQueue(10);
    const queued = qs.getQueuedJobs();
    const active = qs.getActiveJob();
    const lines: string[] = [];
    if (active) lines.push(`${Icons.running} \`${active.id.slice(0, 8)}\` · ${truncate(active.prompt, 60)} · ${active.status}`);
    for (const q of queued) lines.push(`${Icons.queued} \`${q.id.slice(0, 8)}\` · ${truncate(q.prompt, 60)}`);
    for (const r of recent) {
      lines.push(
        `${r.status === "completed" ? Icons.ok : Icons.fail} \`${r.id.slice(0, 8)}\` · ${truncate(r.prompt, 60)} · ${r.status}`
      );
    }
    if (lines.length === 0) {
      await interaction.editReply({ content: "No jobs yet." });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle("Jobs")
      .setDescription("```\n" + lines.join("\n").slice(0, 3900) + "\n```")
      .setFooter({ text: "OpenCode Remote" });
    await interaction.editReply({ embeds: [embed] });
  }
}

function jobEmbed(
  job: QueueItem,
  extras: { elapsedMs?: number; statusLine?: string; currentAction?: string; position?: number } = {}
): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(jobStatusColor(job.status))
    .setTitle(`${extras.statusLine ?? jobStatusLine(job.status)} · \`${job.id.slice(0, 8)}\``)
    .setFooter({ text: `full id: ${job.id}` })
    .addFields(
      { name: "Project", value: `\`${job.projectAlias}\``, inline: true },
      { name: "Model", value: job.model || "default", inline: true },
      { name: "Session", value: job.sessionId ? `\`${job.sessionId.slice(0, 8)}\`` : "—", inline: true },
      { name: "Prompt", value: truncate(job.prompt, 300) || "(none)", inline: false },
      { name: "Status", value: job.status, inline: true },
      {
        name: "Queue position",
        value: extras.position ? `#${extras.position}` : job.status === "queued" ? `#${qs.getQueuePosition(job.id)}` : "—",
        inline: true,
      },
      { name: "Attempts", value: `${job.attemptCount}`, inline: true },
      {
        name: "Elapsed",
        value: extras.elapsedMs !== undefined ? formatClock(extras.elapsedMs) : job.startedAt ? formatClock((job.finishedAt ?? Date.now()) - job.startedAt) : "—",
        inline: true,
      },
      {
        name: "Last activity",
        value: job.heartbeatAt ? `<t:${Math.floor(job.heartbeatAt / 1000)}:R>` : "—",
        inline: true,
      },
      { name: "Last error", value: job.error || job.lastError ? truncate(job.error || job.lastError || "", 200) : "—", inline: false }
    );
  if (extras.currentAction) {
    embed.addFields({ name: "Current action", value: truncate(extras.currentAction, 120), inline: false });
  }
  if (job.addedAt) {
    embed.addFields({
      name: "Timestamps",
      value: [
        `queued <t:${Math.floor(job.addedAt / 1000)}:R>`,
        job.startedAt ? `started <t:${Math.floor(job.startedAt / 1000)}:R>` : null,
        job.finishedAt ? `finished <t:${Math.floor(job.finishedAt / 1000)}:R>` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      inline: false,
    });
  }
  return embed;
}
