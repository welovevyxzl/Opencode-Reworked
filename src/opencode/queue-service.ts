import { randomUUID } from "crypto";
import type { JobKind, JobStatus, QueueItem } from "../types/index.js";
import { getDatabase, addToQueue, getQueueItem, rowToQueueItem, removeFromQueue } from "../storage/index.js";
import { logInfo, logWarn, logJobEvent } from "../utils/logger.js";
import { generateId } from "../utils/index.js";

/**
 * Persistent queue state machine. SQLite is the single source of truth for
 * queue state; in-memory values are caches only. All state mutations run
 * inside IMMEDIATE transactions so two pumps can never claim the same job
 * or the same execution slot.
 */

export const WORKER_ID = `w-${randomUUID().slice(0, 8)}`;

const ACTIVE_STATUSES: JobStatus[] = ["starting", "running", "cancelling"];
const MAX_AUTO_REQUEUE_ATTEMPTS = 3;

let serviceReady = false;

export function initQueueService(): void {
  const db = getDatabase();
  if (!db) throw new Error("Database must be initialized before the queue service");
  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  serviceReady = true;
  logInfo("Queue service initialized", "queue", { workerId: WORKER_ID });
}

function db() {
  if (!serviceReady || !getDatabase()) throw new Error("Queue service not initialized");
  return getDatabase()!;
}

// ---------------------------------------------------------------------------
// Flags (paused state persists across restarts)
// ---------------------------------------------------------------------------

function readPaused(database: ReturnType<typeof getDatabase> & object): boolean {
  const row = (database as NonNullable<ReturnType<typeof getDatabase>>)
    .prepare("SELECT value FROM queue_flags WHERE key = 'paused'")
    .get() as { value: string } | undefined;
  return row?.value === "1";
}

export function isPaused(): boolean {
  return readPaused(db());
}

export function setPaused(paused: boolean): void {
  db()
    .prepare("INSERT OR REPLACE INTO queue_flags (key, value) VALUES ('paused', ?)")
    .run(paused ? "1" : "0");
  logInfo(paused ? "Queue paused" : "Queue resumed", "queue");
}

/**
 * Failure policy hook (continueOnFailure). When disabled, a failure pauses
 * the queue so nothing else runs until /queue resume. Returns the outcome
 * for Discord reporting.
 */
export function onJobFailure(continueOnFailure: boolean): { paused: boolean } {
  if (!continueOnFailure && !isPaused()) {
    setPaused(true);
    return { paused: true };
  }
  return { paused: false };
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  prompt: string;
  title?: string;
  channelId: string;
  threadId: string;
  projectAlias: string;
  directory?: string;
  sessionId?: string;
  model?: string;
  kind?: JobKind;
  taskId?: string;
}

export function enqueue(opts: EnqueueOptions): QueueItem {
  const item: QueueItem = {
    id: generateId(),
    prompt: opts.prompt,
    title: opts.title,
    channelId: opts.channelId,
    threadId: opts.threadId,
    projectAlias: opts.projectAlias,
    directory: opts.directory,
    sessionId: opts.sessionId,
    model: opts.model,
    kind: opts.kind ?? "prompt",
    taskId: opts.taskId,
    addedAt: Date.now(),
    updatedAt: Date.now(),
    attemptCount: 0,
    status: "queued",
  };
  db().transaction(() => addToQueue(item)).immediate();
  logJobEvent("INFO", "QUEUED", item.id, `Queued ${item.kind} for ${item.projectAlias}`, {
    threadId: item.threadId,
    position: getQueuePosition(item.id),
  });
  return item;
}

// ---------------------------------------------------------------------------
// Claim — the heart of the queue
// ---------------------------------------------------------------------------

/**
 * Atomically claim the next queued job. The IMMEDIATE transaction guarantees:
 *  - only one caller ever moves a job from queued → starting
 *  - a job is never claimed while another job holds the single execution slot
 * Returns null when the queue is empty, paused, or the slot is occupied.
 */
export function claimNextJob(): QueueItem | null {
  const database = db();
  const claim = database.transaction((): QueueItem | null => {
    if (readPaused(database)) return null;
    const active = database
      .prepare("SELECT id FROM queue_items WHERE status IN ('starting','running','cancelling') LIMIT 1")
      .get() as { id: string } | undefined;
    if (active) return null;

    const row = database
      .prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY added_at ASC, rowid ASC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const item = rowToQueueItem(row);
    const now = Date.now();
    const res = database
      .prepare(
        `UPDATE queue_items
         SET status = 'starting', worker_id = ?, started_at = ?, heartbeat_at = ?, updated_at = ?,
             attempt_count = attempt_count + 1
         WHERE id = ? AND status = 'queued'`
      )
      .run(WORKER_ID, now, now, now, item.id);
    if (res.changes !== 1) return null;
    const claimed = database.prepare("SELECT * FROM queue_items WHERE id = ?").get(item.id) as Record<string, unknown>;
    return rowToQueueItem(claimed);
  });
  const job = claim.immediate();
  if (job) {
    logJobEvent("INFO", "CLAIMED", job.id, `Claimed by ${WORKER_ID}`, { attempts: job.attemptCount });
  }
  return job;
}

// ---------------------------------------------------------------------------
// Guarded state transitions
// ---------------------------------------------------------------------------

interface StatusPatch {
  result?: string;
  error?: string;
  sessionId?: string;
}

function setStatus(
  jobId: string,
  to: JobStatus,
  allowedFrom: JobStatus[],
  patch: StatusPatch,
  terminal: boolean
): { ok: boolean; item: QueueItem | null; reason?: string } {
  const database = db();
  const tx = database.transaction((): { ok: boolean; item: QueueItem | null; reason?: string } => {
    const row = database.prepare("SELECT * FROM queue_items WHERE id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return { ok: false, item: null, reason: "not-found" };
    const item = rowToQueueItem(row);
    if (!allowedFrom.includes(item.status)) {
      return { ok: false, item, reason: `invalid-transition-from-${item.status}` };
    }
    const now = Date.now();
    if (terminal) {
      database
        .prepare(
          `UPDATE queue_items SET status = ?, updated_at = ?, heartbeat_at = ?, finished_at = ?,
             result = COALESCE(?, result), error = COALESCE(?, error), session_id = COALESCE(?, session_id)
           WHERE id = ?`
        )
        .run(to, now, now, now, patch.result ?? null, patch.error ?? null, patch.sessionId ?? null, jobId);
    } else {
      database
        .prepare(
          `UPDATE queue_items SET status = ?, updated_at = ?, heartbeat_at = ?,
             session_id = COALESCE(?, session_id)
           WHERE id = ?`
        )
        .run(to, now, now, patch.sessionId ?? null, jobId);
    }
    const updated = database.prepare("SELECT * FROM queue_items WHERE id = ?").get(jobId) as Record<string, unknown>;
    return { ok: true, item: rowToQueueItem(updated) };
  });
  const out = tx.immediate();
  if (!out.ok && out.reason && out.reason !== "not-found") {
    logWarn(`Rejected transition to ${to}`, "queue", { jobId, reason: out.reason });
  }
  return out;
}

export function markRunning(jobId: string, sessionId?: string): boolean {
  const r = setStatus(jobId, "running", ["starting"], { sessionId }, false);
  if (r.ok) logJobEvent("INFO", "RUNNING", jobId, "Job running", { sessionId });
  return r.ok;
}

export function markCancelling(jobId: string, reason = "user requested"): boolean {
  const r = setStatus(jobId, "cancelling", ACTIVE_STATUSES, {}, false);
  if (r.ok) logJobEvent("INFO", "CANCELLING", jobId, `Cancellation requested (${reason})`);
  return r.ok;
}

export function markCompleted(jobId: string, result: string): boolean {
  const r = setStatus(jobId, "completed", ACTIVE_STATUSES, { result }, true);
  if (r.ok) logJobEvent("INFO", "COMPLETED", jobId, "Job completed");
  return r.ok;
}

export function markFailed(jobId: string, error: string, partialResult?: string): boolean {
  const r = setStatus(jobId, "failed", ACTIVE_STATUSES, { result: partialResult, error }, true);
  if (r.ok) logJobEvent("ERROR", "FAILED", jobId, `Job failed: ${error.slice(0, 200)}`);
  return r.ok;
}

/** Idempotent: repeated cancels of an already-cancelled job succeed silently. */
export function markCancelled(jobId: string, note = "cancelled by user"): boolean {
  const item = getQueueItem(jobId);
  if (!item) return false;
  if (item.status === "cancelled") return true;
  const r = setStatus(jobId, "cancelled", ACTIVE_STATUSES, { result: note }, true);
  if (r.ok) logJobEvent("INFO", "CANCELLED", jobId, note);
  return r.ok;
}

export function markInterrupted(jobId: string, error: string): boolean {
  const r = setStatus(jobId, "interrupted", ACTIVE_STATUSES, { error }, true);
  if (r.ok) logJobEvent("WARN", "INTERRUPTED", jobId, `Job interrupted: ${error.slice(0, 200)}`);
  return r.ok;
}

/** Requeue an interrupted/failed job (bounded attempts). */
export function requeueJob(jobId: string, note: string): boolean {
  const database = db();
  const tx = database.transaction((): boolean => {
    const item = getQueueItem(jobId);
    if (!item) return false;
    if (!ACTIVE_STATUSES.includes(item.status) && item.status !== "failed" && item.status !== "interrupted") {
      return false;
    }
    if (item.attemptCount >= MAX_AUTO_REQUEUE_ATTEMPTS) return false;
    database
      .prepare(
        `UPDATE queue_items SET status = 'queued', worker_id = NULL, updated_at = ?,
           started_at = NULL, heartbeat_at = NULL, finished_at = NULL, last_error = ?
         WHERE id = ?`
      )
      .run(Date.now(), note, jobId);
    return true;
  });
  const ok = tx.immediate();
  if (ok) logJobEvent("INFO", "REQUEUED", jobId, note);
  return ok;
}

/** Retry a finished/failed/cancelled/interrupted job on demand (/job retry). */
export function retryJob(jobId: string): { ok: boolean; reason?: string } {
  const database = db();
  const tx = database.transaction((): { ok: boolean; reason?: string } => {
    const item = getQueueItem(jobId);
    if (!item) return { ok: false, reason: "not-found" };
    if (!["failed", "cancelled", "interrupted", "completed"].includes(item.status)) {
      return { ok: false, reason: `job-is-${item.status}` };
    }
    database
      .prepare(
        `UPDATE queue_items SET status = 'queued', worker_id = NULL, updated_at = ?,
           started_at = NULL, heartbeat_at = NULL, finished_at = NULL, error = NULL, result = NULL
         WHERE id = ?`
      )
      .run(Date.now(), jobId);
    return { ok: true };
  });
  const r = tx.immediate();
  if (r.ok) logJobEvent("INFO", "RETRY_QUEUED", jobId, "Retry requested");
  return r;
}

export function updateHeartbeat(jobId: string, activity?: string): void {
  db()
    .prepare(
      "UPDATE queue_items SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status IN ('starting','running','cancelling')"
    )
    .run(Date.now(), Date.now(), jobId);
  if (activity) logJobEvent("DEBUG", "HEARTBEAT", jobId, activity);
}

export function attachSession(jobId: string, sessionId: string): void {
  db()
    .prepare("UPDATE queue_items SET session_id = ?, updated_at = ? WHERE id = ?")
    .run(sessionId, Date.now(), jobId);
  logJobEvent("INFO", "SESSION_RESOLVED", jobId, `Session ${sessionId.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// Clear / remove
// ---------------------------------------------------------------------------

/**
 * Clear every job that has not started. Never touches the active job.
 * Returns exactly how many queued jobs were cleared.
 */
export function clearQueued(): number {
  const database = db();
  const tx = database.transaction(() => {
    const res = database
      .prepare(
        "UPDATE queue_items SET status = 'cancelled', finished_at = ?, updated_at = ?, result = 'cleared from queue' WHERE status = 'queued'"
      )
      .run(Date.now(), Date.now());
    return res.changes;
  });
  const cleared = tx.immediate();
  logInfo(`Cleared ${cleared} queued job(s)`, "queue", { event: "QUEUE_CLEARED" });
  return cleared;
}

/** Remove one queued job completely. Only allowed before it starts. */
export function removeQueuedJob(jobId: string): { ok: boolean; reason?: string } {
  const database = db();
  const tx = database.transaction((): { ok: boolean; reason?: string } => {
    const item = getQueueItem(jobId);
    if (!item) return { ok: false, reason: "not-found" };
    if (item.status !== "queued") return { ok: false, reason: `job-is-${item.status}` };
    removeFromQueue(jobId);
    return { ok: true };
  });
  const r = tx.immediate();
  if (r.ok) logJobEvent("INFO", "REMOVED", jobId, "Removed from queue");
  return r;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/** The authoritative active job straight from SQLite. */
export function getActiveJob(): QueueItem | null {
  const row = db()
    .prepare(
      "SELECT * FROM queue_items WHERE status IN ('starting','running','cancelling') ORDER BY started_at ASC LIMIT 1"
    )
    .get() as Record<string, unknown> | undefined;
  return row ? rowToQueueItem(row) : null;
}

export function hasActiveJob(): boolean {
  return getActiveJob() !== null;
}

export function getQueuedJobs(): QueueItem[] {
  const rows = db()
    .prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY added_at ASC, rowid ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
}

export function getQueuePosition(jobId: string): number {
  const rows = db()
    .prepare("SELECT id FROM queue_items WHERE status = 'queued' ORDER BY added_at ASC, rowid ASC")
    .all() as Array<{ id: string }>;
  const idx = rows.findIndex((r) => r.id === jobId);
  return idx >= 0 ? idx + 1 : 0;
}

export function getJob(jobId: string): QueueItem | null {
  return getQueueItem(jobId);
}

/** Resolve a short id (unique prefix) to a job. Null when ambiguous or missing. */
export function getJobByShortId(
  shortId: string
): QueueItem | { ambiguous: true; matches: string[] } | null {
  if (!/^[A-Za-z0-9-]{1,32}$/.test(shortId)) return null;
  const rows = db()
    .prepare("SELECT id FROM queue_items WHERE id LIKE ?")
    .all(`${shortId}%`) as Array<{ id: string }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) return { ambiguous: true, matches: rows.slice(0, 5).map((r) => r.id) };
  return getQueueItem(rows[0].id);
}

export interface QueueStats {
  queued: number;
  active: number;
  starting: number;
  running: number;
  cancelling: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  paused: boolean;
  workerId: string;
  activeJobId: string | null;
}

export function getQueueStats(): QueueStats {
  const rows = db()
    .prepare("SELECT status, COUNT(*) as n FROM queue_items GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const stats: QueueStats = {
    queued: 0, active: 0, starting: 0, running: 0, cancelling: 0,
    completed: 0, failed: 0, cancelled: 0, interrupted: 0,
    paused: isPaused(),
    workerId: WORKER_ID,
    activeJobId: null,
  };
  for (const r of rows) {
    switch (r.status) {
      case "queued": stats.queued = r.n; break;
      case "starting": stats.starting = r.n; stats.active += r.n; break;
      case "running": stats.running = r.n; stats.active += r.n; break;
      case "cancelling": stats.cancelling = r.n; stats.active += r.n; break;
      case "completed": stats.completed = r.n; break;
      case "failed": stats.failed = r.n; break;
      case "cancelled": stats.cancelled = r.n; break;
      case "interrupted": stats.interrupted = r.n; break;
    }
  }
  const active = getActiveJob();
  stats.activeJobId = active?.id ?? null;
  return stats;
}

export function getStaleJobs(staleAfterMs: number): QueueItem[] {
  const cutoff = Date.now() - staleAfterMs;
  const rows = db()
    .prepare(
      `SELECT * FROM queue_items
       WHERE status IN ('starting','running')
         AND heartbeat_at IS NOT NULL AND heartbeat_at < ?
         AND started_at < ?`
    )
    .all(cutoff, cutoff) as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
}

// ---------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------

export interface RecoveryReport {
  inspected: number;
  requeued: string[];
  interrupted: Array<{ jobId: string; reason: string }>;
  cancelled: string[];
}

/**
 * Called once on startup before the queue is pumped. Resolves jobs left in
 * starting/running/cancelling by a previous (crashed) process so the queue
 * can never stay permanently locked.
 */
export async function recoverInterruptedJobs(opts: {
  sessionAlive: (sessionId: string | undefined) => Promise<boolean>;
}): Promise<RecoveryReport> {
  const report: RecoveryReport = { inspected: 0, requeued: [], interrupted: [], cancelled: [] };
  const database = db();
  const rows = database
    .prepare("SELECT * FROM queue_items WHERE status IN ('starting','running','cancelling')")
    .all() as Record<string, unknown>[];
  const jobs = rows.map(rowToQueueItem);
  report.inspected = jobs.length;

  for (const job of jobs) {
    const alive = await opts.sessionAlive(job.sessionId);
    if (job.status === "cancelling") {
      // A cancel was requested before the crash; treat it as cancelled.
      markCancelled(job.id, "cancelled during restart (was already cancelling)");
      report.cancelled.push(job.id);
      continue;
    }
    if (alive && job.attemptCount < MAX_AUTO_REQUEUE_ATTEMPTS) {
      requeueJob(job.id, "requeued after restart (OpenCode session still alive)");
      report.requeued.push(job.id);
      continue;
    }
    markInterrupted(
      job.id,
      alive
        ? `Interrupted by restart; attempts exhausted (${job.attemptCount}).`
        : "Interrupted by restart; the OpenCode session no longer exists."
    );
    report.interrupted.push({ jobId: job.id, reason: alive ? "attempts-exhausted" : "session-gone" });
  }
  if (report.inspected > 0) {
    logInfo("Startup recovery complete", "queue", { ...report, event: "RECOVERED" });
  }
  return report;
}
