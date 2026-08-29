import { randomUUID } from "crypto";
import { Colors } from "discord.js";
import {
  getTask,
  saveTask,
  getActiveTasks,
  updateTask,
} from "../storage/index.js";
import { logInfo, logWarn, logError, logJobEvent } from "../utils/logger.js";
import * as qs from "./queue-service.js";
import { baseEmbed, Icons } from "../discord/ui.js";
import { sendThreadMessage } from "./engine.js";
import {
  parseTaskState,
  serializeTaskState,
  buildContinuationPrompt,
  extractTaskSignal,
  shouldAbortForRepeatedFailure,
  nextFailureState,
  resolveProjectDirectory,
  runVerification,
  DEFAULT_MAX_ITERATIONS,
} from "./task-logic.js";
import type { TaskRecord } from "../types/index.js";

/**
 * Autopilot task runner. A /task creates a persistent TaskRecord and queues
 * iteration 1. When a task job finishes, the runner evaluates progress,
 * runs the verification loop (build/typecheck/test/lint from package.json),
 * and either queues the next continuation iteration or finalizes the task.
 * All state lives in SQLite so a restart resumes rather than erases tasks.
 */

export interface CreateTaskOptions {
  prompt: string;
  projectAlias: string;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
  mode: "normal" | "autopilot";
  maxIterations: number;
}

export async function createTask(opts: CreateTaskOptions): Promise<TaskRecord> {
  const directory = resolveProjectDirectory(opts.projectAlias);
  const task: TaskRecord = {
    id: `task-${randomUUID().slice(0, 8)}`,
    prompt: opts.prompt,
    projectAlias: opts.projectAlias,
    directory,
    channelId: opts.channelId,
    threadId: opts.threadId,
    sessionId: opts.sessionId,
    mode: opts.mode,
    status: opts.mode === "autopilot" ? "running" : "pending",
    maxIterations: Math.min(Math.max(opts.maxIterations, 1), 25),
    iteration: 0,
    stateJson: serializeTaskState({
      objective: opts.prompt.slice(0, 300),
      remainingWork: [],
      consecutiveIdenticalFailures: 0,
      acceptanceMet: false,
    }),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  saveTask(task);
  await queueTaskIteration(task, opts.prompt, `Iteration 1/${task.maxIterations}`);
  return task;
}

async function queueTaskIteration(task: TaskRecord, prompt: string, title: string): Promise<void> {
  const { queuePrompt } = await import("./engine.js");
  await queuePrompt({
    prompt,
    title,
    channelId: task.channelId ?? task.threadId ?? "",
    threadId: task.threadId ?? "",
    projectAlias: task.projectAlias,
    sessionId: task.sessionId,
    kind: "task",
    taskId: task.id,
  });
}

/**
 * Called by the engine when any job with a taskId reaches a terminal state.
 * Drives the autopilot loop.
 */
export async function notifyTaskJobFinished(taskId: string, jobId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) return;
  if (task.status !== "running") return;

  const job = qs.getJob(jobId);
  if (!job) return;

  // Track the session the job used so continuations reuse it.
  if (job.sessionId && job.sessionId !== task.sessionId) {
    task.sessionId = job.sessionId;
  }

  if (job.status === "cancelled" || job.status === "interrupted") {
    updateTask(taskId, { status: "paused" });
    await sendTaskStatus(task, `Task paused — iteration job was ${job.status}. Use \`/task resume ${taskId.slice(5, 10)}\` to continue.`);
    return;
  }

  if (job.status === "failed") {
    const state = parseTaskState(task.stateJson);
    const error = job.error || "iteration failed";
    if (shouldAbortForRepeatedFailure(state, error)) {
      const newState = nextFailureState(state, error);
      updateTask(taskId, {
        status: "failed",
        stateJson: serializeTaskState(newState),
      });
      await sendTaskStatus(task, `Task failed — the same error repeated ${newState.consecutiveIdenticalFailures} times. Manual intervention needed:\n\`\`\`\n${error.slice(0, 500)}\n\`\`\``, Colors.Red);
      return;
    }
    // Failure does not consume an iteration slot; queue a continuation to
    // diagnose and fix, so the loop is resilient to non-identical failures.
    const newState = nextFailureState(state, error);
    updateTask(taskId, { stateJson: serializeTaskState(newState) });
    await queueTaskIteration(
      { ...task, iteration: task.iteration, stateJson: serializeTaskState(newState) },
      `Previous iteration failed (${error.slice(0, 200)}). Diagnose and fix it.`,
      `Retry after failure (iteration ${task.iteration + 1}/${task.maxIterations})`
    );
    return;
  }

  if (job.status !== "completed") return;

  // Successful iteration → consume slot.
  const iteration = task.iteration + 1;
  task.iteration = iteration;
  updateTask(taskId, { iteration });

  const output = job.result || "";
  const signal = extractTaskSignal(output);

  // --- Verification loop (real commands; never claimed without running) ---
  let verification = null as Awaited<ReturnType<typeof runVerification>> | null;
  if (task.mode === "autopilot" && task.directory) {
    try {
      verification = await runVerification(task.directory, jobId);
    } catch (err) {
      logWarn(`Verification crashed for ${taskId}: ${String(err)}`, "task-runner");
    }
  }

  const state = parseTaskState(task.stateJson);
  state.lastOutput = output.slice(-2000);
  if (verification) {
    state.lastVerification = {
      at: Date.now(),
      summary: verification.summary,
      failed: verification.results.filter((r) => !r.ok).map((r) => r.label),
    };
  }

  const verificationPassed = !verification || verification.allRequiredPassed;
  const complete = signal.complete && verificationPassed;

  if (complete || iteration >= task.maxIterations) {
    state.acceptanceMet = complete;
    updateTask(taskId, {
      status: "completed",
      stateJson: serializeTaskState(state),
    });
    const banner = complete
      ? `Task complete after ${iteration} iteration${iteration === 1 ? "" : "s"}.`
      : `Reached the iteration limit (${task.maxIterations}). ${
          verification ? `Verification: ${verification.summary}` : "Signal said complete but verification could not run."
        }`;
    await sendTaskStatus(task, banner, complete ? Colors.Green : Colors.Orange);
    logJobEvent("INFO", "TASK_DONE", jobId, `Task ${taskId} finished`, { iterations: iteration, complete });
    return;
  }

  // Continue: derive remaining work from TASK_REMAINING line + verification.
  if (signal.remainingLine) {
    state.remainingWork = [signal.remainingLine];
  }
  updateTask(taskId, { stateJson: serializeTaskState(state) });

  const nextIteration = iteration + 1;
  const continuation = buildContinuationPrompt(state, nextIteration, task.maxIterations, output, verification);
  await queueTaskIteration(
    { ...task, iteration },
    continuation,
    `Iteration ${nextIteration}/${task.maxIterations}`
  );
  await sendTaskStatus(
    task,
    `Iteration ${iteration}/${task.maxIterations} finished. Verification: ${verification ? verification.summary : "n/a"}.\nContinuing — remaining: ${signal.remainingLine ?? "assessing"}`,
    Colors.Blue
  );
}

/** Resume a paused task from where it left off. */
export async function resumeTask(taskId: string): Promise<{ ok: boolean; message: string }> {
  const task = getTask(taskId);
  if (!task) return { ok: false, message: "Task not found." };
  if (task.status !== "paused" && task.status !== "pending") {
    return { ok: false, message: `Task is ${task.status}.` };
  }
  if (task.iteration >= task.maxIterations) {
    return { ok: false, message: "Task already reached its iteration limit." };
  }
  const state = parseTaskState(task.stateJson);
  updateTask(taskId, { status: "running" });
  const nextIteration = task.iteration + 1;
  const continuation = buildContinuationPrompt(state, nextIteration, task.maxIterations, state.lastOutput ?? "", null);
  await queueTaskIteration(task, continuation, `Iteration ${nextIteration}/${task.maxIterations}`);
  return { ok: true, message: `Resumed at iteration ${nextIteration}/${task.maxIterations}.` };
}

export async function cancelTask(taskId: string): Promise<{ ok: boolean; message: string }> {
  const task = getTask(taskId);
  if (!task) return { ok: false, message: "Task not found." };
  if (task.status === "completed" || task.status === "cancelled" || task.status === "failed") {
    return { ok: false, message: `Task already ${task.status}.` };
  }
  // Cancel any queued continuation jobs for this task.
  for (const job of qs.getQueuedJobs()) {
    if (job.taskId === taskId) qs.removeQueuedJob(job.id);
  }
  updateTask(taskId, { status: "cancelled" });
  const active = qs.getActiveJob();
  if (active?.taskId === taskId) {
    const { stopCurrentJob } = await import("./engine.js");
    await stopCurrentJob();
  }
  return { ok: true, message: "Task cancelled." };
}

async function sendTaskStatus(task: TaskRecord, message: string, color: number = Colors.Blue): Promise<void> {
  if (!task.threadId) return;
  try {
    await sendThreadMessage(
      task.threadId,
      baseEmbed(color)
        .setTitle(`${Icons.running} Task \`${task.id.slice(5, 10)}\` · ${task.mode}`)
        .setDescription(message.slice(0, 3900))
    );
  } catch (err) {
    logWarn(`Task status send failed: ${String(err)}`, "task-runner");
  }
}

/** Startup recovery for tasks: revive tasks orphaned by a restart. */
export function recoverTasksOnStartup(): { resumed: number; paused: number } {
  let resumed = 0;
  let paused = 0;
  for (const task of getActiveTasks()) {
    if (task.status === "running") {
      // If no job is currently executing for it, it was interrupted by the crash.
      const activeJob = qs.getActiveJob();
      if (!activeJob || activeJob.taskId !== task.id) {
        // Leave it paused with a clear resume path; auto-resume for autopilot.
        if (task.iteration < task.maxIterations) {
          updateTask(task.id, { status: "paused" });
          void resumeTask(task.id)
            .then(() => {
              resumed++;
              logInfo(`Task ${task.id} auto-resumed after restart`, "task-runner");
            })
            .catch((err) => logError(`Task ${task.id} resume failed: ${String(err)}`, "task-runner"));
        } else {
          updateTask(task.id, { status: "paused" });
          paused++;
        }
      }
    } else if (task.status === "pending") {
      void resumeTask(task.id).catch(() => undefined);
      resumed++;
    }
  }
  return { resumed, paused };
}

export { DEFAULT_MAX_ITERATIONS };
