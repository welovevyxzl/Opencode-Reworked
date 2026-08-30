import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import type {
  Config,
  ProjectState,
  ChannelBinding,
  QueueItem,
  AllowlistEntry,
  AutocodeMode,
  TaskRecord,
  PendingAction,
} from "../types/index.js";
import { logInfo, logError } from "../utils/logger.js";
import Database from "better-sqlite3";

const DATA_DIR = join(homedir(), ".opencode-remote");
const CONFIG_PATH = join(DATA_DIR, "config.json");
const DB_PATH = join(DATA_DIR, "data.db");

let db: Database.Database | null = null;

export function getDatabase(): Database.Database | null {
  return db;
}

export function getHomeDir(): string {
  return DATA_DIR;
}

export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!existsSync(join(DATA_DIR, "logs"))) {
    mkdirSync(join(DATA_DIR, "logs"), { recursive: true });
  }
  if (!existsSync(join(DATA_DIR, "state"))) {
    mkdirSync(join(DATA_DIR, "state"), { recursive: true });
  }
}

export function loadConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Config;
    if (!parsed.startup) {
      parsed.startup = { bootWithWindows: false };
    }
    if (parsed.startup.mode === undefined) {
      parsed.startup.mode = parsed.startup.bootWithWindows ? "login" : "disabled";
    }
    if (!parsed.queue) {
      parsed.queue = { continueOnFailure: true, freshContext: false };
    }
    return parsed;
  } catch (err) {
    logError("Failed to load config", "storage", err);
    return null;
  }
}

export function saveConfig(config: Config): void {
  ensureDataDir();
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
    logInfo("Config saved", "storage");
  } catch (err) {
    logError("Failed to save config", "storage", err);
    throw err;
  }
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

// ---------------------------------------------------------------------------
// Schema + migrations
// ---------------------------------------------------------------------------

export function initDatabase(): void {
  ensureDataDir();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Step 1: create tables (NO indexes on columns that may not exist yet in a
  // pre-refactor database). CREATE TABLE IF NOT EXISTS is a no-op for tables
  // that already exist, so this never drops or rewrites existing data.
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_states (
      alias TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      selected_model TEXT DEFAULT '',
      autocode_enabled INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS channel_bindings (
      channel_id TEXT PRIMARY KEY,
      project_alias TEXT NOT NULL,
      active_session_id TEXT,
      autocode_enabled INTEGER DEFAULT 0,
      autocode_mode TEXT DEFAULT 'inherit',
      is_thread INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS thread_sessions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      channel_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS queue_items (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      title TEXT,
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      directory TEXT,
      session_id TEXT,
      model TEXT,
      kind TEXT DEFAULT 'prompt',
      task_id TEXT,
      added_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      updated_at INTEGER,
      heartbeat_at INTEGER,
      attempt_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'queued',
      result TEXT,
      error TEXT,
      last_error TEXT,
      worker_id TEXT
    );
    CREATE TABLE IF NOT EXISTS allowlist (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      added_by TEXT NOT NULL,
      is_owner INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      directory TEXT,
      channel_id TEXT,
      thread_id TEXT,
      session_id TEXT,
      mode TEXT DEFAULT 'normal',
      status TEXT DEFAULT 'pending',
      max_iterations INTEGER DEFAULT 10,
      iteration INTEGER DEFAULT 0,
      state_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pending_actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      channel_id TEXT,
      project_alias TEXT,
      payload_json TEXT,
      requester_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  // Step 2: run migrations BEFORE any CREATE INDEX / statement that references
  // the newly-added columns, so an old database that is missing e.g. task_id is
  // brought up to the current schema before ANY index on that column is built.
  runMigrations(db);

  // Step 3: create indexes only now that every referenced column is guaranteed
  // to exist (fresh DBs get them here; migrated DBs get them after the ALTERs).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue_items(status, added_at);
    CREATE INDEX IF NOT EXISTS idx_queue_task ON queue_items(task_id);
  `);

  logInfo("Database initialized", "storage");
}

function runMigrations(database: Database.Database): void {
  // Idempotent, ordered column migrations. SQLite has no `ADD COLUMN IF NOT
  // EXISTS`, so each table is inspected via PRAGMA table_info() against the
  // REAL existing schema, and a column is only added when it is genuinely
  // missing. Re-applying on a fresh or already-migrated database is a no-op,
  // and no existing rows are touched (except the explicit backfills below).
  ensureColumns(database, "project_states", [
    ["autocode_enabled", "INTEGER DEFAULT 0"],
  ]);
  ensureColumns(database, "channel_bindings", [
    ["autocode_enabled", "INTEGER DEFAULT 0"],
    ["autocode_mode", "TEXT DEFAULT 'inherit'"],
    ["is_thread", "INTEGER DEFAULT 0"],
  ]);
  ensureColumns(database, "queue_items", [
    ["title", "TEXT"],
    ["directory", "TEXT"],
    ["model", "TEXT"],
    ["kind", "TEXT DEFAULT 'prompt'"],
    ["task_id", "TEXT"],
    ["started_at", "INTEGER"],
    ["finished_at", "INTEGER"],
    ["updated_at", "INTEGER"],
    ["heartbeat_at", "INTEGER"],
    ["attempt_count", "INTEGER DEFAULT 0"],
    ["last_error", "TEXT"],
    ["worker_id", "TEXT"],
  ]);
  // The tasks table grew several columns in the refactor; bring any pre-existing
  // (old-shape) tasks table up to the current schema too.
  ensureColumns(database, "tasks", [
    ["directory", "TEXT"],
    ["channel_id", "TEXT"],
    ["thread_id", "TEXT"],
    ["session_id", "TEXT"],
    ["mode", "TEXT DEFAULT 'normal'"],
    ["status", "TEXT DEFAULT 'pending'"],
    ["max_iterations", "INTEGER DEFAULT 10"],
    ["iteration", "INTEGER DEFAULT 0"],
    ["state_json", "TEXT"],
    ["updated_at", "INTEGER"],
  ]);
  ensureColumns(database, "pending_actions", [
    ["channel_id", "TEXT"],
    ["project_alias", "TEXT"],
    ["payload_json", "TEXT"],
  ]);

  // Backfill attempt_count/updated_at for existing (migrated) rows.
  database.exec(
    "UPDATE queue_items SET attempt_count = 0 WHERE attempt_count IS NULL"
  );
  database.exec(
    "UPDATE queue_items SET updated_at = added_at WHERE updated_at IS NULL"
  );
}

/**
 * Inspect the real schema of `table` via PRAGMA table_info and add any of the
 * given [column, declaration] pairs that are missing. Column declarations match
 * the current TypeScript schema exactly. SQLite fills existing rows with the
 * declared DEFAULT for TYPEd columns that carry one; columns without a DEFAULT
 * are simply NULL for pre-existing rows, which the row-parsers treat as absent.
 */
function ensureColumns(
  database: Database.Database,
  table: string,
  columns: Array<[string, string]>
): void {
  const existing = database
    .prepare(`PRAGMA table_info(${table})`)
    .all() as Array<{ name: string }>;
  const names = new Set(existing.map((c) => c.name));
  for (const [name, decl] of columns) {
    if (names.has(name)) continue;
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized");
  return db;
}

// ---------------------------------------------------------------------------
// Project state
// ---------------------------------------------------------------------------

export function getProjectState(alias: string): ProjectState | null {
  const row = getDb()
    .prepare("SELECT * FROM project_states WHERE alias = ?")
    .get(alias) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    alias: row.alias as string,
    path: row.path as string,
    selectedModel: (row.selected_model as string) || "",
    threadSessionMap: new Map(),
    autocodeEnabled: Boolean(row.autocode_enabled),
    channelBindings: new Map(),
  };
}

export function getAllProjectStates(): ProjectState[] {
  const rows = getDb().prepare("SELECT * FROM project_states").all() as Record<
    string,
    unknown
  >[];
  return rows.map((row) => ({
    alias: row.alias as string,
    path: row.path as string,
    selectedModel: (row.selected_model as string) || "",
    threadSessionMap: new Map(),
    autocodeEnabled: Boolean(row.autocode_enabled),
    channelBindings: new Map(),
  }));
}

export function saveProjectState(state: ProjectState): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO project_states (alias, path, selected_model, autocode_enabled)
       VALUES (?, ?, ?, ?)`
    )
    .run(state.alias, state.path, state.selectedModel, state.autocodeEnabled ? 1 : 0);
}

export function deleteProjectState(alias: string): void {
  getDb().prepare("DELETE FROM project_states WHERE alias = ?").run(alias);
}

// ---------------------------------------------------------------------------
// Channel bindings (thread-aware, explicit autocode inheritance)
// ---------------------------------------------------------------------------

function modeFromRow(row: Record<string, unknown>): AutocodeMode {
  const mode = row.autocode_mode as string | null;
  if (mode === "enabled" || mode === "disabled" || mode === "inherit") return mode;
  // legacy boolean fallback
  const legacy = Boolean(row.autocode_enabled);
  return legacy ? "enabled" : "inherit";
}

export function getChannelBinding(channelId: string): ChannelBinding | null {
  const row = getDb()
    .prepare("SELECT * FROM channel_bindings WHERE channel_id = ?")
    .get(channelId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const threadSessionMap = getDb()
    .prepare("SELECT thread_id, session_id FROM thread_sessions WHERE channel_id = ?")
    .all(channelId) as Record<string, unknown>[];
  const map = new Map<string, string>();
  for (const ts of threadSessionMap) {
    map.set(ts.thread_id as string, ts.session_id as string);
  }
  return {
    channelId: row.channel_id as string,
    projectAlias: row.project_alias as string,
    autocode: modeFromRow(row),
    autocodeEnabled: modeFromRow(row) === "enabled",
    activeSessionId: (row.active_session_id as string) || undefined,
    threadSessionMap: map,
  };
}

export function saveChannelBinding(binding: ChannelBinding): void {
  const mode: AutocodeMode = binding.autocode || (binding.autocodeEnabled ? "enabled" : "inherit");
  const existing = getDb()
    .prepare("SELECT is_thread FROM channel_bindings WHERE channel_id = ?")
    .get(binding.channelId) as { is_thread?: number } | undefined;
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO channel_bindings (channel_id, project_alias, active_session_id, autocode_enabled, autocode_mode, is_thread)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      binding.channelId,
      binding.projectAlias,
      binding.activeSessionId || null,
      mode === "enabled" ? 1 : 0,
      mode,
      existing?.is_thread ?? 0
    );
}

export function markChannelBindingThread(channelId: string, isThread: boolean): void {
  getDb()
    .prepare("UPDATE channel_bindings SET is_thread = ? WHERE channel_id = ?")
    .run(isThread ? 1 : 0, channelId);
}

export function deleteChannelBinding(channelId: string): void {
  getDb().prepare("DELETE FROM channel_bindings WHERE channel_id = ?").run(channelId);
  getDb().prepare("DELETE FROM thread_sessions WHERE channel_id = ?").run(channelId);
}

/**
 * Effective autocode state for a channel/thread using explicit inheritance.
 * A thread set to `disabled` stays disabled even if the parent is `enabled`.
 */
export function effectiveAutocode(
  threadId: string,
  parentId: string | null
): boolean {
  const threadRow = getDb()
    .prepare("SELECT autocode_mode FROM channel_bindings WHERE channel_id = ?")
    .get(threadId) as { autocode_mode?: string } | undefined;
  if (threadRow && threadRow.autocode_mode && threadRow.autocode_mode !== "inherit") {
    return threadRow.autocode_mode === "enabled";
  }
  if (parentId) {
    const parentRow = getDb()
      .prepare("SELECT autocode_mode FROM channel_bindings WHERE channel_id = ?")
      .get(parentId) as { autocode_mode?: string } | undefined;
    if (parentRow) {
      if (parentRow.autocode_mode === "enabled") return true;
      if (parentRow.autocode_mode === "disabled") return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Thread sessions
// ---------------------------------------------------------------------------

export function getThreadSession(threadId: string): { sessionId: string; projectAlias: string } | null {
  const row = getDb()
    .prepare("SELECT * FROM thread_sessions WHERE thread_id = ?")
    .get(threadId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id as string,
    projectAlias: row.project_alias as string,
  };
}

export function saveThreadSession(
  threadId: string,
  sessionId: string,
  projectAlias: string,
  channelId: string
): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO thread_sessions (thread_id, session_id, project_alias, channel_id)
       VALUES (?, ?, ?, ?)`
    )
    .run(threadId, sessionId, projectAlias, channelId);
}

export function deleteThreadSession(threadId: string): void {
  getDb().prepare("DELETE FROM thread_sessions WHERE thread_id = ?").run(threadId);
}

export function findThreadBySession(sessionId: string): { threadId: string; projectAlias: string } | null {
  const row = getDb()
    .prepare("SELECT * FROM thread_sessions WHERE session_id = ?")
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    threadId: row.thread_id as string,
    projectAlias: row.project_alias as string,
  };
}

// ---------------------------------------------------------------------------
// Queue items (raw storage access; the queue service wraps these in transactions)
// ---------------------------------------------------------------------------

export function addToQueue(item: QueueItem): void {
  getDb()
    .prepare(
      `INSERT INTO queue_items (id, prompt, title, channel_id, thread_id, project_alias, directory, session_id, model, kind, task_id, added_at, attempt_count, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.prompt,
      item.title || null,
      item.channelId,
      item.threadId,
      item.projectAlias,
      item.directory || null,
      item.sessionId || null,
      item.model || null,
      item.kind,
      item.taskId || null,
      item.addedAt,
      item.attemptCount ?? 0,
      item.status,
      Date.now()
    );
}

export function getQueueItem(id: string): QueueItem | null {
  const row = getDb()
    .prepare("SELECT * FROM queue_items WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToQueueItem(row);
}

export function getPendingQueue(): QueueItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY added_at ASC, rowid ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
}

export function getAllQueue(): QueueItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM queue_items WHERE status IN ('queued','starting','running','cancelling')
       ORDER BY added_at ASC, rowid ASC`
    )
    .all() as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
}

export function getRecentFinishedQueue(limit = 20): QueueItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM queue_items WHERE status IN ('completed','failed','cancelled','interrupted')
       ORDER BY finished_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
}

export function getLastJobForThread(threadId: string): QueueItem | null {
  const row = getDb()
    .prepare("SELECT * FROM queue_items WHERE thread_id = ? ORDER BY added_at DESC LIMIT 1")
    .get(threadId) as Record<string, unknown> | undefined;
  return row ? rowToQueueItem(row) : null;
}

export function updateQueueItem(id: string, updates: Partial<QueueItem>): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.result !== undefined) {
    setClauses.push("result = ?");
    values.push(updates.result);
  }
  if (updates.error !== undefined) {
    setClauses.push("error = ?");
    values.push(updates.error);
  }
  if (updates.lastError !== undefined) {
    setClauses.push("last_error = ?");
    values.push(updates.lastError);
  }
  if (updates.sessionId !== undefined) {
    setClauses.push("session_id = ?");
    values.push(updates.sessionId || null);
  }
  if (updates.directory !== undefined) {
    setClauses.push("directory = ?");
    values.push(updates.directory || null);
  }
  if (setClauses.length === 0) return;
  setClauses.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE queue_items SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function removeFromQueue(id: string): void {
  getDb().prepare("DELETE FROM queue_items WHERE id = ?").run(id);
}

/** Legacy clear used by tests: marks queued items cancelled. */
export function clearQueue(): void {
  getDb().prepare("UPDATE queue_items SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE status = 'queued'").run(Date.now(), Date.now());
}

export function rowToQueueItem(row: Record<string, unknown>): QueueItem {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    title: (row.title as string) || undefined,
    channelId: row.channel_id as string,
    threadId: row.thread_id as string,
    projectAlias: row.project_alias as string,
    directory: (row.directory as string) || undefined,
    sessionId: (row.session_id as string) || undefined,
    model: (row.model as string) || undefined,
    kind: ((row.kind as string) || "prompt") as QueueItem["kind"],
    taskId: (row.task_id as string) || undefined,
    addedAt: row.added_at as number,
    startedAt: (row.started_at as number) || undefined,
    finishedAt: (row.finished_at as number) || undefined,
    updatedAt: (row.updated_at as number) || undefined,
    heartbeatAt: (row.heartbeat_at as number) || undefined,
    attemptCount: (row.attempt_count as number) || 0,
    status: row.status as QueueItem["status"],
    result: (row.result as string) || undefined,
    error: (row.error as string) || undefined,
    lastError: (row.last_error as string) || undefined,
    workerId: (row.worker_id as string) || undefined,
  };
}

// ---------------------------------------------------------------------------
// Tasks (autopilot)
// ---------------------------------------------------------------------------

export function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    projectAlias: row.project_alias as string,
    directory: (row.directory as string) || undefined,
    channelId: (row.channel_id as string) || undefined,
    threadId: (row.thread_id as string) || undefined,
    sessionId: (row.session_id as string) || undefined,
    mode: ((row.mode as string) || "normal") as TaskRecord["mode"],
    status: ((row.status as string) || "pending") as TaskRecord["status"],
    maxIterations: (row.max_iterations as number) || 10,
    iteration: (row.iteration as number) || 0,
    stateJson: (row.state_json as string) || undefined,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

export function saveTask(task: TaskRecord): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO tasks (id, prompt, project_alias, directory, channel_id, thread_id, session_id, mode, status, max_iterations, iteration, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.id,
      task.prompt,
      task.projectAlias,
      task.directory || null,
      task.channelId || null,
      task.threadId || null,
      task.sessionId || null,
      task.mode,
      task.status,
      task.maxIterations,
      task.iteration,
      task.stateJson || null,
      task.createdAt,
      Date.now()
    );
}

export function getTask(id: string): TaskRecord | null {
  const row = getDb().prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTask(row) : null;
}

export function getActiveTasks(): TaskRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM tasks WHERE status IN ('pending','running') ORDER BY created_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function getRecentTasks(limit = 20): TaskRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?")
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function deleteTask(id: string): void {
  getDb().prepare("DELETE FROM tasks WHERE id = ?").run(id);
}

export function updateTask(id: string, updates: Partial<TaskRecord>): void {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  if (updates.prompt !== undefined) {
    setClauses.push("prompt = ?");
    values.push(updates.prompt);
  }
  if (updates.status !== undefined) {
    setClauses.push("status = ?");
    values.push(updates.status);
  }
  if (updates.mode !== undefined) {
    setClauses.push("mode = ?");
    values.push(updates.mode);
  }
  if (updates.directory !== undefined) {
    setClauses.push("directory = ?");
    values.push(updates.directory || null);
  }
  if (updates.sessionId !== undefined) {
    setClauses.push("session_id = ?");
    values.push(updates.sessionId || null);
  }
  if (updates.maxIterations !== undefined) {
    setClauses.push("max_iterations = ?");
    values.push(updates.maxIterations);
  }
  if (updates.iteration !== undefined) {
    setClauses.push("iteration = ?");
    values.push(updates.iteration);
  }
  if (updates.stateJson !== undefined) {
    setClauses.push("state_json = ?");
    values.push(updates.stateJson || null);
  }
  if (setClauses.length === 0) return;
  setClauses.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
}

// ---------------------------------------------------------------------------
// Integrity / writability checks (doctor)
// ---------------------------------------------------------------------------

export function checkDatabaseIntegrity(): { ok: boolean; message: string } {
  if (!db) return { ok: true, message: "database not open" };
  try {
    const row = db.pragma("integrity_check", { simple: true }) as unknown;
    const value = (Array.isArray(row) ? row[0] : row) as unknown;
    const text = String(value).trim();
    return { ok: text === "ok", message: text === "ok" ? "no corruption detected" : text.slice(0, 200) };
  } catch (err) {
    return { ok: false, message: `integrity check failed: ${String(err)}` };
  }
}

export function checkDatabaseWritable(): { ok: boolean; message: string } {
  if (!db) return { ok: false, message: "database not open" };
  try {
    db.prepare("CREATE TABLE IF NOT EXISTS _write_probe (id INTEGER)").run();
    db.prepare("INSERT INTO _write_probe (id) VALUES (1)").run();
    db.prepare("DELETE FROM _write_probe").run();
    return { ok: true, message: "writable" };
  } catch (err) {
    return { ok: false, message: `database is read-only: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Pending actions (durable component interactions)
// ---------------------------------------------------------------------------

export function savePendingAction(action: PendingAction): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO pending_actions (id, type, channel_id, project_alias, payload_json, requester_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      action.id,
      action.type,
      action.channelId || null,
      action.projectAlias || null,
      action.payloadJson || null,
      action.requesterId,
      action.createdAt,
      action.expiresAt
    );
}

export function getPendingAction(id: string): PendingAction | null {
  const row = getDb()
    .prepare("SELECT * FROM pending_actions WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    type: row.type as string,
    channelId: (row.channel_id as string) || undefined,
    projectAlias: (row.project_alias as string) || undefined,
    payloadJson: (row.payload_json as string) || undefined,
    requesterId: row.requester_id as string,
    createdAt: row.created_at as number,
    expiresAt: row.expires_at as number,
  };
}

export function deletePendingAction(id: string): void {
  getDb().prepare("DELETE FROM pending_actions WHERE id = ?").run(id);
}

export function cleanupExpiredPendingActions(): number {
  const res = getDb()
    .prepare("DELETE FROM pending_actions WHERE expires_at < ?")
    .run(Date.now());
  return res.changes;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export function getAllowlist(): AllowlistEntry[] {
  const rows = getDb()
    .prepare("SELECT * FROM allowlist ORDER BY is_owner DESC, added_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    userId: row.user_id as string,
    username: row.username as string,
    addedAt: row.added_at as number,
    addedBy: row.added_by as string,
    isOwner: Boolean(row.is_owner),
  }));
}

export function addToAllowlist(entry: AllowlistEntry): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO allowlist (user_id, username, added_at, added_by, is_owner)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(entry.userId, entry.username, entry.addedAt, entry.addedBy, entry.isOwner ? 1 : 0);
}

export function removeFromAllowlist(userId: string): boolean {
  const entry = getDb()
    .prepare("SELECT * FROM allowlist WHERE user_id = ?")
    .get(userId) as Record<string, unknown> | undefined;
  if (!entry) return false;
  if (entry.is_owner) return false;

  const totalCount = (getDb()
    .prepare("SELECT COUNT(*) as cnt FROM allowlist")
    .get() as Record<string, unknown>).cnt as number;
  if (totalCount <= 1) return false;

  getDb().prepare("DELETE FROM allowlist WHERE user_id = ?").run(userId);
  return true;
}

export function isAuthorized(userId: string): boolean {
  const row = getDb()
    .prepare("SELECT user_id FROM allowlist WHERE user_id = ?")
    .get(userId) as Record<string, unknown> | undefined;
  return !!row;
}

export function isOwner(userId: string): boolean {
  const row = getDb()
    .prepare("SELECT is_owner FROM allowlist WHERE user_id = ?")
    .get(userId) as Record<string, unknown> | undefined;
  return row ? Boolean(row.is_owner) : false;
}
