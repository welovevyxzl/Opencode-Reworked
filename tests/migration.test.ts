import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, unlinkSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import {
  initDatabase,
  closeDatabase,
  getDatabase,
  getHomeDir,
  ensureDataDir,
  getQueueItem,
} from "../src/storage/index.js";

// Represents the PRE-refactor schema: queue_items and tasks are missing the
// columns the current refactor added (task_id, timestamps, state-machine fields).
// We also plant data in every table to prove migrations never delete rows.
function buildOldSchema(): void {
  ensureDataDir();
  const dbPath = join(getHomeDir(), "data.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (existsSync(p)) unlinkSync(p);
  }
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE project_states (
      alias TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      selected_model TEXT DEFAULT ''
    );
    CREATE TABLE channel_bindings (
      channel_id TEXT PRIMARY KEY,
      project_alias TEXT NOT NULL,
      active_session_id TEXT
    );
    CREATE TABLE thread_sessions (
      thread_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      channel_id TEXT NOT NULL
    );
    CREATE TABLE queue_items (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      status TEXT DEFAULT 'queued',
      result TEXT,
      error TEXT
    );
    CREATE TABLE allowlist (
      user_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      added_by TEXT NOT NULL,
      is_owner INTEGER DEFAULT 0
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      project_alias TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE pending_actions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      requester_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  const ins = db.prepare(
    "INSERT INTO queue_items (id, prompt, channel_id, thread_id, project_alias, added_at, status, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const queuedRows = [
    { id: "q-queued", prompt: "helo", added_at: 100, status: "queued" },
    { id: "q-running", prompt: "in flight", added_at: 200, status: "running", result: null },
  ];
  for (const r of queuedRows) {
    ins.run(r.id, r.prompt, "c", "t", "p", r.added_at, r.status, r.result);
  }
  db.prepare("INSERT INTO project_states (alias, path, selected_model) VALUES ('proj', 'C:/proj', '')").run();
  db.prepare("INSERT INTO channel_bindings (channel_id, project_alias) VALUES ('chan', 'proj')").run();
  db.prepare(
    "INSERT INTO thread_sessions (thread_id, session_id, project_alias, channel_id) VALUES ('t', 'sess', 'proj', 'chan')"
  ).run();
  db.prepare(
    "INSERT INTO allowlist (user_id, username, added_at, added_by, is_owner) VALUES ('u', 'alice', 1, 'setup', 1)"
  ).run();
  db.prepare("INSERT INTO tasks (id, prompt, project_alias, created_at) VALUES ('task-1', 'do it', 'proj', 1)").run();
  db.close();
}

function queueColumnNames(): string[] {
  const db = getDatabase()!;
  return (db.prepare("PRAGMA table_info(queue_items)").all() as Array<{ name: string }>).map((c) => c.name);
}

const REFACTOR_QUEUE_COLUMNS = [
  "title",
  "directory",
  "model",
  "kind",
  "task_id",
  "started_at",
  "finished_at",
  "updated_at",
  "heartbeat_at",
  "attempt_count",
  "last_error",
  "worker_id",
];

describe("database migration (pre-refactor upgrade)", () => {
  beforeEach(() => {
    closeDatabase();
    buildOldSchema();
    // This is the code under test: it must bring the OLD schema up to date
    // and create the task_id index WITHOUT crashing or dropping data.
    initDatabase();
  });

  afterAll(() => {
    closeDatabase();
  });

  it("adds every refactor column to queue_items (including task_id) without crashing", () => {
    for (const col of REFACTOR_QUEUE_COLUMNS) {
      expect(queueColumnNames()).toContain(col);
    }
  });

  it("builds the idx_queue_task index on the migrated task_id column", () => {
    const db = getDatabase()!;
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queue_items'").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_queue_task");
    expect(names).toContain("idx_queue_status");
  });

  it("preserves every pre-existing row across the migration", () => {
    const db = getDatabase()!;
    const queue = db
      .prepare("SELECT id, prompt, status FROM queue_items ORDER BY added_at ASC")
      .all() as Array<{ id: string; prompt: string; status: string }>;
    expect(queue).toEqual([
      { id: "q-queued", prompt: "helo", status: "queued" },
      { id: "q-running", prompt: "in flight", status: "running" },
    ]);
    const others = {
      projects: (db.prepare("SELECT COUNT(*) AS c FROM project_states").get() as { c: number }).c,
      bindings: (db.prepare("SELECT COUNT(*) AS c FROM channel_bindings").get() as { c: number }).c,
      sessions: (db.prepare("SELECT COUNT(*) AS c FROM thread_sessions").get() as { c: number }).c,
      allowlist: (db.prepare("SELECT COUNT(*) AS c FROM allowlist").get() as { c: number }).c,
      tasks: (db.prepare("SELECT COUNT(*) AS c FROM tasks").get() as { c: number }).c,
    };
    expect(others).toEqual({ projects: 1, bindings: 1, sessions: 1, allowlist: 1, tasks: 1 });
  });

  it("reads migrated rows through the public row-parser", () => {
    expect(getQueueItem("q-queued")!.prompt).toBe("helo");
    expect(getQueueItem("q-queued")!.status).toBe("queued");
    expect(getQueueItem("q-running")!.status).toBe("running");
  });

  it("adds the refactor columns to an old tasks table", () => {
    const db = getDatabase()!;
    const names = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of ["directory", "channel_id", "thread_id", "session_id", "mode", "status", "max_iterations", "iteration", "state_json", "updated_at"]) {
      expect(names).toContain(col);
    }
  });

  it("adds the refactor columns to an old pending_actions table", () => {
    const db = getDatabase()!;
    const names = (db.prepare("PRAGMA table_info(pending_actions)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const col of ["channel_id", "project_alias", "payload_json"]) {
      expect(names).toContain(col);
    }
  });

  it("is idempotent: re-running initDatabase on the migrated DB is a no-op and keeps data", () => {
    // Second startup against the ALREADY-migrated database must not throw and
    // must not duplicate/drop anything.
    closeDatabase();
    initDatabase();
    const db = getDatabase()!;
    const count = (db.prepare("SELECT COUNT(*) AS c FROM queue_items").get() as { c: number }).c;
    expect(count).toBe(2);
    for (const col of REFACTOR_QUEUE_COLUMNS) {
      expect(queueColumnNames()).toContain(col);
    }
  });
});
