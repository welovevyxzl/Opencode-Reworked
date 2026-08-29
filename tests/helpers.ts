import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "fs";

/**
 * Test bootstrap: point %USERPROFILE%/%HOME% at a fresh temp dir so the
 * storage layer creates its SQLite DB and config in an isolated sandbox.
 * Deterministic fake Discord snowflake IDs are used across queue tests.
 */

let fakeHome: string | null = null;

export function useFakeHome(): string {
  if (!fakeHome) {
    fakeHome = mkdtempSync(join(tmpdir(), "ocr-test-home-"));
    process.env.USERPROFILE = fakeHome;
    process.env.HOME = fakeHome;
  }
  return fakeHome;
}

/** Reset module-level state between test groups by recreating the fake home. */
export function resetFakeHome(): void {
  if (fakeHome) {
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {
      // Windows file locks; best effort
    }
  }
  fakeHome = null;
  useFakeHome();
}

export const THREAD_ID = "900000000000000001";
export const PARENT_ID = "900000000000000002";
export const OWNER_ID = "900000000000000003";
export const CHANNEL_B = "900000000000000004";

export function makeQueueRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "test-job-1",
    prompt: "do the thing",
    title: null,
    channel_id: PARENT_ID,
    thread_id: THREAD_ID,
    project_alias: "proj",
    directory: null,
    session_id: null,
    model: null,
    kind: "prompt",
    task_id: null,
    added_at: Date.now(),
    started_at: null,
    finished_at: null,
    updated_at: Date.now(),
    heartbeat_at: null,
    attempt_count: 0,
    status: "queued",
    result: null,
    error: null,
    last_error: null,
    worker_id: null,
    ...overrides,
  };
}

export function writePackageJson(dir: string, pkg: Record<string, unknown>): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
}

export function readJsonFile(path: string): any {
  return JSON.parse(readFileSync(path, "utf-8"));
}
