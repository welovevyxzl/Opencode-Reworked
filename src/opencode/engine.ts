import { Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type Message } from "discord.js";
import {
  loadConfig,
  getProjectState,
  getChannelBinding,
  saveChannelBinding,
  getThreadSession,
  saveThreadSession,
} from "../storage/index.js";
import { logInfo, logWarn, logError, logJobEvent } from "../utils/logger.js";
import { formatClock, truncate } from "../utils/index.js";
import * as oc from "./manager.js";
import * as qs from "./queue-service.js";
import { resolveDiscordChannel } from "../discord/channels.js";
import { Icons, baseEmbed, jobStatusLine } from "../discord/ui.js";
import { buildPromptContext } from "./project-context.js";
import { notifyTaskJobFinished } from "./task-runner.js";
import type { PromptEvent } from "./events.js";
import type { JobKind, QueueItem } from "../types/index.js";

/**
 * Execution engine. All queue state lives in SQLite via queue-service; the
 * engine only executes claimed jobs, updates heartbeats, renders Discord
 * status, and pumps the next job when the slot frees.
 */

type RuntimeStatus =
  | "starting"
  | "working"
  | "retrying"
  | "disconnected"
  | "stalled"
  | "cancelling";

interface JobRuntime {
  job: QueueItem;
  sessionId: string;
  statusMessageId: string | null;
  startedAt: number;
  model: string;
  streamBuffer: string;
  toolCalls: Map<string, { name: string; output?: string; error?: string }>;
  lastMeaningful: string;
  lastEventTs: number;
  lastStatus: RuntimeStatus;
  cancelRequested: boolean;
  heartbeatTimer: NodeJS.Timeout | null;
  watchdogTimer: NodeJS.Timeout | null;
  consecutiveDisconnects: number;
}

let runtime: JobRuntime | null = null;
let pumping = false;
let engineReady = false;

export function initEngine(): void {
  if (engineReady) return;
  engineReady = true;
  logInfo("Engine initialized", "engine", { workerId: qs.WORKER_ID });
}

// ---------------------------------------------------------------------------
// Settings passthrough (persisted in config)
// ---------------------------------------------------------------------------

export function queueSettings() {
  const config = loadConfig();
  return {
    continueOnFailure: config?.queue.continueOnFailure ?? true,
    freshContext: config?.queue.freshContext ?? false,
  };
}

export async function updateSettings(opts: { continueOnFailure?: boolean; freshContext?: boolean }): Promise<void> {
  const config = loadConfig();
  if (!config) return;
  if (opts.continueOnFailure !== undefined) config.queue.continueOnFailure = opts.continueOnFailure;
  if (opts.freshContext !== undefined) config.queue.freshContext = opts.freshContext;
  const { saveConfig } = await import("../storage/index.js");
  saveConfig(config);
}

// ---------------------------------------------------------------------------
// Enqueue + pump
// ---------------------------------------------------------------------------

export interface QueuePromptOptions {
  prompt: string;
  title?: string;
  channelId: string;
  threadId: string;
  projectAlias: string;
  sessionId?: string;
  model?: string;
  kind?: JobKind;
  taskId?: string;
}

export async function queuePrompt(opts: QueuePromptOptions): Promise<string> {
  const state = getProjectState(opts.projectAlias);
  const item = qs.enqueue({
    prompt: opts.prompt,
    title: opts.title,
    channelId: opts.channelId,
    threadId: opts.threadId,
    projectAlias: opts.projectAlias,
    directory: state?.path?.trim() || undefined,
    sessionId: opts.sessionId,
    model: opts.model || state?.selectedModel || undefined,
    kind: opts.kind,
    taskId: opts.taskId,
  });
  void pumpQueue();
  return item.id;
}

export async function pumpQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      if (qs.isPaused()) return;
      if (runtime) return; // a job is executing in this process
      const claimed = qs.claimNextJob();
      if (!claimed) return;
      await runClaimedJob(claimed);
      if (qs.isPaused()) return;
    }
  } catch (err) {
    logError(`Queue pump crashed: ${String(err)}`, "engine");
  } finally {
    pumping = false;
  }
}

// ---------------------------------------------------------------------------
// Job execution
// ---------------------------------------------------------------------------

function resolveDirectory(item: QueueItem): string | undefined {
  const state = getProjectState(item.projectAlias);
  const registered = loadConfig()?.projects?.registered?.find((p) => p.alias === item.projectAlias);
  return item.directory?.trim() || state?.path?.trim() || registered?.path?.trim() || undefined;
}

async function runClaimedJob(item: QueueItem): Promise<void> {
  const config = loadConfig();
  const directory = resolveDirectory(item);

  // --- Session resolution: job session → thread session → create + rebind ---
  let sessionId = item.sessionId || "";
  const freshContext = config?.queue?.freshContext ?? false;
  if (!freshContext && !sessionId) {
    const ts = getThreadSession(item.threadId);
    if (ts?.sessionId) sessionId = ts.sessionId;
  }
  if (!freshContext && sessionId) {
    const alive = await oc.isSessionAlive(sessionId).catch(() => false);
    if (!alive) {
      logWarn(`Thread session ${sessionId.slice(0, 8)} vanished; creating a replacement`, "engine", { jobId: item.id });
      sessionId = "";
    }
  }
  if (freshContext) sessionId = "";

  if (!sessionId) {
    const created = await oc.createSession(`Discord · ${item.projectAlias}`, directory);
    if (!created) {
      await finishWithFailure(item, "Failed to create an OpenCode session. Is OpenCode healthy? Run /doctor.");
      return;
    }
    sessionId = created.id;
    saveThreadSession(item.threadId, sessionId, item.projectAlias, item.channelId);
    const binding = getChannelBinding(item.channelId);
    if (binding) {
      binding.activeSessionId = sessionId;
      saveChannelBinding(binding);
    }
  }

  qs.attachSession(item.id, sessionId);
  if (!qs.markRunning(item.id, sessionId)) {
    const current = qs.getJob(item.id);
    if (current?.status === "cancelled" || current?.status === "cancelling") {
      qs.markCancelled(item.id, "cancelled before start");
      await postCompletionFor(item, false, "Cancelled before the prompt was sent.");
    }
    return;
  }

  const state = getProjectState(item.projectAlias);
  runtime = {
    job: { ...item, sessionId },
    sessionId,
    statusMessageId: null,
    startedAt: Date.now(),
    model: item.model || state?.selectedModel || "default",
    streamBuffer: "",
    toolCalls: new Map(),
    lastMeaningful: "",
    lastEventTs: Date.now(),
    lastStatus: "starting",
    cancelRequested: false,
    heartbeatTimer: null,
    watchdogTimer: null,
    consecutiveDisconnects: 0,
  };

  // If /stop already marked this job cancelling before runtime existed.
  const afterMark = qs.getJob(item.id);
  if (afterMark?.status === "cancelling") runtime.cancelRequested = true;

  const heartbeatMs = 15_000;
  runtime.heartbeatTimer = setInterval(() => qs.updateHeartbeat(item.id), heartbeatMs);
  const stallTimeoutMs = config?.queue.stallTimeoutMs ?? 10 * 60_000;
  const maxTimeoutMs = config?.queue.maxJobTimeoutMs ?? 60 * 60_000;
  runtime.watchdogTimer = setInterval(
    () => void runWatchdog(item.id, stallTimeoutMs, maxTimeoutMs),
    30_000
  );

  await sendOrUpdateStatus();

  const prompt = item.prompt + buildPromptContext(directory);
  logJobEvent("INFO", "PROMPT_SENT", item.id, "Prompt sent to OpenCode", {
    sessionId,
    model: runtime.model,
  });

  const res = await oc.sendPrompt({
    sessionId,
    prompt,
    directory,
    model: runtime.model === "default" ? undefined : runtime.model,
    onEvent: (event) => handleStreamEvent(item.id, event),
  });

  stopTimers();
  runtime = null;

  // The watchdog or /stop may have finalized the job while the prompt call
  // was in flight — never override a terminal state set elsewhere.
  const finalJob = qs.getJob(item.id);
  const finalStatus = finalJob?.status;
  if (finalStatus === "failed" || finalStatus === "interrupted") {
    await handleFailurePolicy(finalJob ?? item, finalJob?.error ?? "Job ended early.");
  } else if (finalStatus === "cancelled" || finalStatus === "cancelling") {
    qs.markCancelled(item.id, "cancelled by user");
    await postCompletionFor({ ...item, sessionId }, false, "Cancelled.");
  } else if (res.ok) {
    qs.markCompleted(item.id, res.output);
    await postCompletionFor({ ...item, sessionId }, true, res.output);
  } else {
    qs.markFailed(item.id, res.error || "OpenCode prompt failed", res.output);
    await handleFailurePolicy({ ...item, sessionId }, res.error || "OpenCode prompt failed", res.output);
  }

  if (item.taskId) {
    void notifyTaskJobFinished(item.taskId, item.id).catch((err) =>
      logError(`Task notification failed: ${String(err)}`, "task-runner")
    );
  }
}

function stopTimers(): void {
  if (runtime?.heartbeatTimer) clearInterval(runtime.heartbeatTimer);
  if (runtime?.watchdogTimer) clearInterval(runtime.watchdogTimer);
}

async function finishWithFailure(item: QueueItem, error: string): Promise<void> {
  qs.markFailed(item.id, error);
  await handleFailurePolicy(item, error);
  if (item.taskId) {
    void notifyTaskJobFinished(item.taskId, item.id).catch(() => undefined);
  }
}

/** continueOnFailure enforcement: pause the queue on failure when disabled. */
async function handleFailurePolicy(item: QueueItem, error: string, partial?: string): Promise<void> {
  await postCompletionFor(item, false, partial ? `${partial}\n\n**Error:** ${error}` : error);
  const settings = queueSettings();
  const outcome = qs.onJobFailure(settings.continueOnFailure);
  if (outcome.paused) {
    await sendThreadMessage(
      item.threadId,
      baseEmbed(Colors.Orange)
        .setTitle(`${Icons.fail} Queue paused`)
        .setDescription(
          `Job \`${item.id.slice(0, 8)}\` failed and **continue on failure** is disabled, so the queue paused instead of moving on.\n\n` +
            `Use \`/queue resume\` to continue processing (the failed job can be retried with \`/job retry ${item.id.slice(0, 8)}\`).`
        )
    );
  }
}

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------

async function runWatchdog(jobId: string, stallTimeoutMs: number, maxTimeoutMs: number): Promise<void> {
  const rt = runtime;
  if (!rt || rt.job.id !== jobId) return;
  qs.updateHeartbeat(jobId, rt.lastStatus);

  if (rt.cancelRequested) return; // abort in flight; /stop logic will finish it

  // Hard cap regardless of activity — legitimate long jobs get hours, not infinity.
  if (Date.now() - rt.startedAt > maxTimeoutMs) {
    logJobEvent("WARN", "WATCHDOG_TIMEOUT", jobId, `Exceeded maximum job duration (${Math.round(maxTimeoutMs / 60000)}min); failing`);
    await oc.cancelSession(rt.sessionId).catch(() => undefined);
    qs.markFailed(jobId, `Job exceeded the maximum duration (${Math.round(maxTimeoutMs / 60000)} minutes) and was stopped by the watchdog. Use /job retry to run it again.`);
    return;
  }

  // Distinguish: alive+working / retrying / disconnected / stalled.
  const healthy = await oc.isHealthy().catch(() => false);
  if (!healthy) {
    rt.consecutiveDisconnects++;
    rt.lastStatus = "disconnected";
    await sendOrUpdateStatus();
    if (rt.consecutiveDisconnects >= 10) {
      logJobEvent("ERROR", "WATCHDOG_DISCONNECTED", jobId, "OpenCode unreachable for ~5 minutes; failing job");
      qs.markFailed(jobId, "OpenCode server became unreachable while the job was running. Run /doctor, then /job retry to resume.");
    }
    return;
  }
  rt.consecutiveDisconnects = 0;

  if (rt.lastStatus === "retrying") return; // OpenCode itself is retrying; give it room

  const idleFor = Date.now() - rt.lastEventTs;
  if (idleFor > stallTimeoutMs) {
    rt.lastStatus = "stalled";
    await sendOrUpdateStatus();
    logJobEvent("WARN", "WATCHDOG_STALLED", jobId, `No activity for ${Math.round(idleFor / 60000)}min; aborting session`);
    await oc.cancelSession(rt.sessionId).catch(() => undefined);
    qs.markFailed(jobId, `No activity from OpenCode for ${Math.round(idleFor / 60000)} minutes (stalled). The job can be retried with /job retry.`);
  }
}

// ---------------------------------------------------------------------------
// Stream events (already session-filtered by the events layer)
// ---------------------------------------------------------------------------

function handleStreamEvent(jobId: string, event: PromptEvent): void {
  const rt = runtime;
  if (!rt || rt.job.id !== jobId) return; // stale events never pass

  switch (event.type) {
    case "token":
      if (event.text) rt.streamBuffer += event.text;
      break;
    case "tool_start":
      if (event.toolCallId && event.tool) {
        rt.toolCalls.set(event.toolCallId, { name: event.tool });
        rt.lastMeaningful = `${event.tool}`;
        logJobEvent("DEBUG", "TOOL_EVENT", jobId, `tool ${event.tool}`);
      }
      break;
    case "tool_complete":
      if (event.toolCallId) {
        const tc = rt.toolCalls.get(event.toolCallId);
        if (tc) tc.output = event.toolOutput;
      }
      break;
    case "tool_error":
      if (event.toolCallId) {
        const tc = rt.toolCalls.get(event.toolCallId);
        if (tc) tc.error = event.toolError;
      }
      break;
    case "diff":
      if (event.file) rt.lastMeaningful = `editing ${event.file}`;
      break;
    case "status":
      if (event.status === "retry") rt.lastStatus = "retrying";
      else if (event.status === "busy" && rt.lastStatus !== "cancelling") rt.lastStatus = "working";
      break;
    case "error":
      rt.lastMeaningful = `error: ${event.message?.slice(0, 80)}`;
      break;
    case "finish":
      rt.lastMeaningful = "finishing";
      break;
  }

  rt.lastEventTs = Date.now();
  if (
    rt.lastStatus !== "cancelling" &&
    rt.lastStatus !== "disconnected" &&
    rt.lastStatus !== "retrying" &&
    event.type !== "status"
  ) {
    rt.lastStatus = "working";
  }
  void sendOrUpdateStatus();
}

// ---------------------------------------------------------------------------
// Discord status rendering
// ---------------------------------------------------------------------------

const STATUS_LINE: Record<RuntimeStatus, string> = {
  starting: "○ Starting",
  working: "● Working",
  retrying: "↻ OpenCode retrying",
  disconnected: "⚠ Disconnected — watchdog recovering",
  stalled: "⚠ Stalled — watchdog recovering",
  cancelling: "■ Cancelling",
};

async function sendOrUpdateStatus(): Promise<void> {
  const rt = runtime;
  if (!rt) return;
  try {
    const channel = await resolveDiscordChannel(rt.job.threadId);
    if (!channel) return;

    const stats = qs.getQueueStats();
    const embed = baseEmbed(Colors.Blue)
      .setTitle("OpenCode")
      .setDescription(`**${rt.job.title || truncate(rt.job.prompt, 120)}**`)
      .addFields(
        { name: "Status", value: STATUS_LINE[rt.lastStatus], inline: true },
        { name: "Elapsed", value: formatClock(Date.now() - rt.startedAt), inline: true },
        { name: "Queue", value: stats.queued > 0 ? `${stats.queued} waiting` : "empty", inline: true },
        { name: "Project", value: `\`${rt.job.projectAlias}\``, inline: true },
        { name: "Model", value: rt.model, inline: true },
        { name: "Session", value: `\`${rt.sessionId.slice(0, 8)}\``, inline: true },
        { name: "Current action", value: rt.lastMeaningful ? `\`${truncate(rt.lastMeaningful, 60)}\`` : "*starting…*", inline: false }
      );

    if (rt.streamBuffer) {
      embed.addFields({ name: "Output", value: "```\n" + truncate(rt.streamBuffer.slice(-800), 800) + "\n```", inline: false });
    }
    if (rt.toolCalls.size > 0) {
      const lines: string[] = [];
      for (const [, tc] of rt.toolCalls) {
        const mark = tc.error ? "✗" : tc.output ? "✓" : "⟳";
        lines.push(`${mark} \`${tc.name}\``);
      }
      embed.addFields({ name: "Tools", value: lines.slice(-5).join("  "), inline: false });
    }

    const components = buildControls(rt);

    if (rt.statusMessageId) {
      try {
        const message = await channel.messages.fetch(rt.statusMessageId);
        await message.edit({ embeds: [embed], components });
        return;
      } catch {
        rt.statusMessageId = null;
      }
    }
    const msg: Message | null = await channel.send({ embeds: [embed], components });
    if (msg) rt.statusMessageId = msg.id;
  } catch (err) {
    logWarn(`Status update failed: ${String(err)}`, "engine");
  }
}

function buildControls(rt: JobRuntime) {
  const stopping = rt.cancelRequested || rt.lastStatus === "cancelling";
  const stop = new ButtonBuilder()
    .setCustomId("oc_stop")
    .setLabel("Stop")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(stopping);
  const regen = new ButtonBuilder()
    .setCustomId("oc_regen")
    .setLabel("Regenerate")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true); // valid only after completion; re-enabled on the done embed
  const cont = new ButtonBuilder()
    .setCustomId("oc_continue")
    .setLabel("Continue")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true); // valid only when no job is running
  const news = new ButtonBuilder()
    .setCustomId("oc_new")
    .setLabel("New Session")
    .setStyle(ButtonStyle.Secondary);
  const diff = new ButtonBuilder()
    .setCustomId("oc_diff")
    .setLabel("Diff")
    .setStyle(ButtonStyle.Secondary);
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(stop, regen, cont, news, diff)];
}

async function postCompletionFor(item: QueueItem, ok: boolean, text: string): Promise<void> {
  const status = qs.getJob(item.id)?.status ?? (ok ? "completed" : "failed");
  const embed = baseEmbed(ok ? Colors.Green : Colors.Red)
    .setTitle(
      ok
        ? `${Icons.ok} Done · \`${item.id.slice(0, 8)}\``
        : `${jobStatusLine(status)} · \`${item.id.slice(0, 8)}\``
    )
    .setDescription(text ? truncate(text, 3900) : "(no output)");
  await sendThreadMessage(item.threadId, embed);
}

export async function sendThreadMessage(threadId: string, content: unknown): Promise<void> {
  try {
    const channel = await resolveDiscordChannel(threadId);
    if (!channel) {
      logWarn(`Cannot post to thread ${threadId}: not resolvable`, "engine");
      return;
    }
    // discord.js v14's .send() accepts string | MessagePayload | MessageCreateOptions,
    // not a bare EmbedBuilder. Wrapping it as { embeds: [...] } is required, otherwise
    // the message has no content and Discord rejects it with 50006 "empty message".
    const payload = content instanceof EmbedBuilder ? { embeds: [content] } : content;
    await channel.send(payload as never);
  } catch (err) {
    logWarn(`Thread message failed (${threadId}): ${String(err)}`, "engine");
  }
}

// ---------------------------------------------------------------------------
// Stop (idempotent)
// ---------------------------------------------------------------------------

export async function stopCurrentJob(): Promise<{ ok: boolean; message: string }> {
  const active = qs.getActiveJob();
  if (!active) return { ok: false, message: "No task is currently running." };

  if (active.status === "cancelling") {
    return { ok: true, message: "Cancellation already in progress — the task will stop shortly." };
  }
  if (!qs.markCancelling(active.id)) {
    const now = qs.getJob(active.id);
    return { ok: false, message: `Job is already ${now?.status ?? "finished"}.` };
  }
  if (runtime && runtime.job.id === active.id) {
    runtime.cancelRequested = true;
    runtime.lastStatus = "cancelling";
    void sendOrUpdateStatus();
  }
  if (active.sessionId) {
    const abort = await oc.cancelSession(active.sessionId);
    if (!abort.ok) {
      logWarn(`OpenCode refused abort; watchdog will recover: ${abort.error}`, "engine", { jobId: active.id });
      // The watchdog's hard timeout guarantees the queue eventually unlocks.
    }
  }
  return { ok: true, message: "Stop requested. The current task will finish cancelling shortly." };
}

/** Cancel a specific job by id (used by /job cancel and /queue clear include-running). */
export async function cancelJobById(jobId: string): Promise<{ ok: boolean; message: string }> {
  const job = qs.getJob(jobId);
  if (!job) return { ok: false, message: "Job not found." };
  if (job.status === "queued") {
    const r = qs.removeQueuedJob(jobId);
    return r.ok ? { ok: true, message: "Removed from queue." } : { ok: false, message: `Could not remove: ${r.reason}` };
  }
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") {
    return { ok: false, message: `Job already ${job.status}.` };
  }
  return stopCurrentJob();
}

// ---------------------------------------------------------------------------
// Introspection helpers used by commands
// ---------------------------------------------------------------------------

export function getActiveJobView(): {
  job: QueueItem;
  elapsedMs: number;
  status: RuntimeStatus;
  currentAction: string;
} | null {
  const active = qs.getActiveJob();
  if (!active) return null;
  const rt = runtime && runtime.job.id === active.id ? runtime : null;
  return {
    job: active,
    elapsedMs: rt ? Date.now() - rt.startedAt : Date.now() - (active.startedAt ?? active.addedAt),
    status: rt
      ? rt.lastStatus
      : active.status === "cancelling"
        ? "cancelling"
        : active.status === "starting"
          ? "starting"
          : "working",
    currentAction: rt?.lastMeaningful ?? "",
  };
}

export function getEngineStatus(): {
  running: boolean;
  jobId: string | null;
  runtimeStatus: RuntimeStatus | null;
  lastAction: string | null;
} {
  const rt = runtime;
  return {
    running: rt !== null,
    jobId: rt?.job.id ?? qs.getActiveJob()?.id ?? null,
    runtimeStatus: rt?.lastStatus ?? null,
    lastAction: rt?.lastMeaningful ?? null,
  };
}

export function isBusy(): boolean {
  return qs.hasActiveJob();
}

export function configOpenCodeManager(): void {
  const config = loadConfig();
  if (config) oc.configure(config);
}

// ---------------------------------------------------------------------------
// Shutdown + startup recovery
// ---------------------------------------------------------------------------

/** On graceful shutdown: try to stop OpenCode and resolve the active job. */
export async function shutdownEngine(): Promise<void> {
  const active = qs.getActiveJob();
  stopTimers();
  if (active) {
    if (active.sessionId) await oc.cancelSession(active.sessionId).catch(() => undefined);
    if (active.status === "cancelling") {
      qs.markCancelled(active.id, "cancelled during shutdown");
    } else {
      qs.markInterrupted(active.id, "Bot shut down while the job was running. Use /job retry to resume.");
    }
    runtime = null;
  }
  logInfo("Engine shut down", "engine");
}

/** Startup recovery: resolve jobs orphaned by a crash, then resume pumping. */
export async function recoverOnStartup(): Promise<qs.RecoveryReport> {
  const report = await qs.recoverInterruptedJobs({
    sessionAlive: (sessionId) => oc.isSessionAlive(sessionId),
  });
  void pumpQueue();
  return report;
}
