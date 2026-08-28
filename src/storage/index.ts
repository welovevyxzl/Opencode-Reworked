import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import type { Config, ProjectState, ChannelBinding, QueueItem, AllowlistEntry } from "../types/index.js";
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
    return JSON.parse(raw) as Config;
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

export function initDatabase(): void {
  ensureDataDir();
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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
      active_session_id TEXT
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
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      session_id TEXT,
      added_at INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      result TEXT,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS allowlist (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      added_by TEXT NOT NULL,
      is_owner INTEGER DEFAULT 0
    );
  `);

  const bindingCols = db
    .prepare("PRAGMA table_info(channel_bindings)")
    .all() as Array<{ name: string }>;
  if (!bindingCols.some((c) => c.name === "autocode_enabled")) {
    db.exec("ALTER TABLE channel_bindings ADD COLUMN autocode_enabled INTEGER DEFAULT 0");
  }

  const projectCols = db
    .prepare("PRAGMA table_info(project_states)")
    .all() as Array<{ name: string }>;
  if (!projectCols.some((c) => c.name === "autocode_enabled")) {
    db.exec("ALTER TABLE project_states ADD COLUMN autocode_enabled INTEGER DEFAULT 0");
  }

  logInfo("Database initialized", "storage");
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
    autocodeEnabled: Boolean(row.autocode_enabled),
    activeSessionId: (row.active_session_id as string) || undefined,
    threadSessionMap: map,
  };
}

export function saveChannelBinding(binding: ChannelBinding): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO channel_bindings (channel_id, project_alias, active_session_id, autocode_enabled)
       VALUES (?, ?, ?, ?)`
    )
    .run(binding.channelId, binding.projectAlias, binding.activeSessionId || null, binding.autocodeEnabled ? 1 : 0);
}

export function deleteChannelBinding(channelId: string): void {
  getDb().prepare("DELETE FROM channel_bindings WHERE channel_id = ?").run(channelId);
  getDb().prepare("DELETE FROM thread_sessions WHERE channel_id = ?").run(channelId);
}

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

export function addToQueue(item: QueueItem): void {
  getDb()
    .prepare(
      `INSERT INTO queue_items (id, prompt, channel_id, thread_id, project_alias, session_id, added_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(item.id, item.prompt, item.channelId, item.threadId, item.projectAlias, item.sessionId || null, item.addedAt, item.status);
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
    .prepare("SELECT * FROM queue_items WHERE status = 'queued' ORDER BY added_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
}

export function getAllQueue(): QueueItem[] {
  const rows = getDb()
    .prepare("SELECT * FROM queue_items WHERE status IN ('queued', 'running') ORDER BY added_at ASC")
    .all() as Record<string, unknown>[];
  return rows.map(rowToQueueItem);
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
  if (updates.sessionId !== undefined) {
    setClauses.push("session_id = ?");
    values.push(updates.sessionId);
  }
  if (setClauses.length === 0) return;
  values.push(id);
  getDb()
    .prepare(`UPDATE queue_items SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
}

export function removeFromQueue(id: string): void {
  getDb().prepare("DELETE FROM queue_items WHERE id = ?").run(id);
}

export function clearQueue(): void {
  getDb().prepare("UPDATE queue_items SET status = 'cancelled' WHERE status = 'queued'").run();
}

function rowToQueueItem(row: Record<string, unknown>): QueueItem {
  return {
    id: row.id as string,
    prompt: row.prompt as string,
    channelId: row.channel_id as string,
    threadId: row.thread_id as string,
    projectAlias: row.project_alias as string,
    sessionId: (row.session_id as string) || undefined,
    addedAt: row.added_at as number,
    status: row.status as QueueItem["status"],
    result: (row.result as string) || undefined,
    error: (row.error as string) || undefined,
  };
}

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
