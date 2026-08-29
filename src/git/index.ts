import { runCommand } from "../utils/index.js";
import type { GitStatus } from "../types/index.js";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";

// Unit Separator (\x1f) — a control character that cannot appear in commit
// subjects or author names, unlike "|" which collides constantly.
export const GIT_LOG_SEPARATOR = "\u001f";

export async function gitCommand(
  cwd: string,
  args: string[],
  timeout = 30000
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand("git", args, { cwd, timeout });
  return {
    ok: result.code === 0,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await gitCommand(cwd, ["rev-parse", "--is-inside-work-tree"], 5000);
  return res.ok && res.stdout.trim() === "true";
}

export async function getStatus(cwd: string): Promise<GitStatus | null> {
  const branchRes = await gitCommand(cwd, ["branch", "--show-current"], 5000);
  if (!branchRes.ok) return null;
  const branch = branchRes.stdout.trim();

  const statusRes = await gitCommand(cwd, ["status", "--porcelain=v1"], 5000);
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  for (const line of statusRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code[0] !== " " && code[0] !== "?") staged.push(file);
    if (code[1] === "M" || code[1] === "D" || code[1] === "R") modified.push(file);
    if (code[0] === "?" && code[1] === "?") untracked.push(file);
  }

  const aheadBehind = await gitCommand(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], 5000);
  let ahead = 0;
  let behind = 0;
  if (aheadBehind.ok) {
    const parts = aheadBehind.stdout.trim().split(/\s+/);
    if (parts.length === 2) {
      ahead = parseInt(parts[0], 10);
      behind = parseInt(parts[1], 10);
    }
  }

  return {
    branch,
    clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
    ahead: isNaN(ahead) ? 0 : ahead,
    behind: isNaN(behind) ? 0 : behind,
    staged,
    modified,
    untracked,
  };
}

export async function getDiff(
  cwd: string,
  opts: { type?: "unstaged" | "staged" | "branch"; base?: string; stat?: boolean } = {}
): Promise<{ ok: boolean; output: string; error?: string }> {
  const args = ["diff"];
  if (opts.stat) args.push("--stat");
  if (opts.type === "staged") args.push("--cached");
  else if (opts.type === "branch") {
    const base = opts.base || "HEAD";
    args.push(base + "...");
  }
  const res = await gitCommand(cwd, args, 30000);
  if (!res.ok) {
    return { ok: false, output: "", error: res.stderr || "Git diff failed" };
  }
  return { ok: true, output: res.stdout };
}

export async function diffToFile(cwd: string, diff: string): Promise<string> {
  void cwd;
  const dir = join(homedir(), ".opencode-remote", "state");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `diff-${Date.now()}-${randomBytes(4).toString("hex")}.diff`);
  writeFileSync(file, diff, "utf-8");
  return file;
}

export async function listBranches(cwd: string): Promise<string[]> {
  const res = await gitCommand(cwd, ["branch", "--format=%(refname:short)"], 5000);
  if (!res.ok) return [];
  return res.stdout.split("\n").map((b) => b.trim()).filter(Boolean);
}

export async function checkoutBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["checkout", branch], 30000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function createBranch(cwd: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["checkout", "-b", branch], 30000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function createWorktree(cwd: string, branch: string, description: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  const base = join(cwd, "..");
  const target = join(base, `${description || "work"}-${branch.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
  const args = ["worktree", "add", "-b", branch, target];
  const res = await gitCommand(cwd, args, 30000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true, path: target };
}

export async function deleteWorktree(cwd: string, path: string): Promise<{ ok: boolean; error?: string }> {
  const status = await getStatus(cwd);
  if (status && !status.clean) {
    return { ok: false, error: "Worktree has uncommitted changes. Commit, stash, or confirm deletion." };
  }
  const args = ["worktree", "remove", "--force", path];
  const res = await gitCommand(cwd, args, 15000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function commit(cwd: string, message: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["commit", "-m", message], 30000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function push(cwd: string, remote = "origin", branch?: string): Promise<{ ok: boolean; error?: string }> {
  const args = branch ? ["push", remote, branch] : ["push"];
  const res = await gitCommand(cwd, args, 60000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function pull(cwd: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["pull"], 60000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export interface CommitEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

/** Parse one `git log` line using the unit-separator format. */
export function parseLogLine(line: string): CommitEntry | null {
  const parts = line.split(GIT_LOG_SEPARATOR);
  if (parts.length < 4) return null;
  const [hash, message, author, date] = parts;
  if (!hash) return null;
  return { hash, message, author, date };
}

export async function log(cwd: string, max = 10): Promise<CommitEntry[]> {
  const res = await gitCommand(
    cwd,
    ["log", `-${max}`, `--pretty=format:%h${GIT_LOG_SEPARATOR}%s${GIT_LOG_SEPARATOR}%an${GIT_LOG_SEPARATOR}%ar`],
    5000
  );
  if (!res.ok) return [];
  return res.stdout
    .split("\n")
    .map(parseLogLine)
    .filter((e): e is CommitEntry => e !== null);
}

export async function stageAll(cwd: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["add", "-A"], 15000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function initRepo(cwd: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["init"], 15000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function remoteUrl(cwd: string): Promise<string> {
  const res = await gitCommand(cwd, ["remote", "get-url", "origin"], 5000);
  return res.ok ? res.stdout.trim() : "";
}

export async function setRemote(cwd: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const res = await gitCommand(cwd, ["remote", "set-url", "origin", url], 5000);
  if (!res.ok) return { ok: false, error: res.stderr || "set-url origin failed" };
  return { ok: true };
}

export async function addRemote(cwd: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const existing = await remoteUrl(cwd);
  if (existing) {
    return setRemote(cwd, url);
  }
  const res = await gitCommand(cwd, ["remote", "add", "origin", url], 5000);
  if (!res.ok) return { ok: false, error: res.stderr };
  return { ok: true };
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const res = await gitCommand(cwd, ["branch", "--show-current"], 5000);
  return res.ok ? res.stdout.trim() : "";
}

export async function initGitIgnore(cwd: string): Promise<void> {
  const p = join(cwd, ".gitignore");
  if (!existsSync(p)) {
    writeFileSync(p, "node_modules/\ndist/\n.env\n");
  }
}

export function containsGitRepo(p: string): boolean {
  return existsSync(join(p, ".git"));
}
