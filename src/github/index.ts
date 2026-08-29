import { resolveBinary, runCommand } from "../utils/index.js";
import { logWarn } from "../utils/logger.js";

/**
 * GitHub CLI wrapper. Every operation takes an explicit project directory —
 * nothing relies on the bot process's cwd. Binary resolution prefers real
 * executables and safely routes .cmd shims through escaped cmd.exe argv.
 */

let ghBinary: string | null = null;

export async function findGh(): Promise<string | null> {
  if (ghBinary && ghBinary.length > 0) return ghBinary;
  const found = resolveBinary("gh");
  if (!found) return null;
  const test = await runCommand(found, ["--version"], { timeout: 10000 });
  if (test.code !== 0) return null;
  ghBinary = found;
  return found;
}

/** Run gh with an explicit cwd (defaults refused: callers must pass project paths). */
async function gh(
  args: string[],
  opts: { cwd: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; code: number }> {
  const bin = await findGh();
  if (!bin) {
    return { stdout: "", stderr: "GitHub CLI not installed. Install it from https://cli.github.com", code: 1 };
  }
  return runCommand(bin, args, { cwd: opts.cwd, timeout: opts.timeout ?? 60000 });
}

export async function isAuthenticated(): Promise<boolean> {
  const bin = await findGh();
  if (!bin) return false;
  const res = await runCommand(bin, ["auth", "status"], { timeout: 15000, cwd: process.cwd() });
  return res.code === 0;
}

export async function authStatus(): Promise<{ authenticated: boolean; user?: string; error?: string }> {
  const bin = await findGh();
  if (!bin) {
    return { authenticated: false, error: "GitHub CLI not found. Install gh from https://cli.github.com" };
  }
  const res = await runCommand(bin, ["auth", "status"], { timeout: 15000, cwd: process.cwd() });
  if (res.code === 0) {
    const match = res.stdout.match(/Logged in to github\.com as ([^\s(.]+)/);
    return { authenticated: true, user: match ? match[1] : "unknown" };
  }
  return { authenticated: false, error: res.stderr || "Not authenticated with gh" };
}

export async function createRepo(
  projectDir: string,
  name: string,
  opts: { visibility?: "private" | "public"; description?: string } = {}
): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!projectDir) return { ok: false, error: "createRepo requires the project directory" };
  // Validate repo name to prevent gh argument/option injection.
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
    return { ok: false, error: "Invalid repository name (letters, digits, . _ - only)." };
  }
  const args = ["repo", "create", name, "--" + (opts.visibility || "private")];
  if (opts.description) {
    args.push("--description", opts.description);
  }
  args.push("--source", projectDir, "--remote", "origin");
  const res = await gh(args, { cwd: projectDir, timeout: 60000 });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || "Repo creation failed" };
  }
  const urlMatch = res.stdout.match(/https:\/\/github\.com\/[^\s]+/);
  return { ok: true, url: urlMatch ? urlMatch[0] : "https://github.com/" + name };
}

export async function createPullRequest(
  projectDir: string,
  opts: {
    title: string;
    body?: string;
    base?: string;
    head?: string;
  }
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const args = ["pr", "create", "--title", opts.title];
  if (opts.body) args.push("--body", opts.body);
  if (opts.base) args.push("--base", opts.base);
  if (opts.head) args.push("--head", opts.head);
  const res = await gh(args, { cwd: projectDir });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || "PR creation failed" };
  }
  const urlMatch = res.stdout.match(/https:\/\/github\.com\/[^\s]+/);
  return { ok: true, url: urlMatch ? urlMatch[0] : undefined };
}

export async function listPullRequests(
  projectDir: string,
  opts: { state?: "open" | "closed" | "all" } = {}
): Promise<
  Array<{ number: number; title: string; url: string; state: string }>
> {
  const args = ["pr", "list", "--state", opts.state || "open", "--json", "number,title,url,state"];
  const res = await gh(args, { cwd: projectDir, timeout: 15000 });
  if (res.code !== 0) {
    logWarn(`gh pr list failed: ${res.stderr}`, "github");
    return [];
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return [];
  }
}

export async function githubCliAvailable(): Promise<boolean> {
  try {
    return !!(await findGh());
  } catch {
    return false;
  }
}

export async function getRepoInfo(
  projectDir: string
): Promise<{ ok: boolean; repo?: { name: string; owner: string; url: string }; error?: string }> {
  const res = await gh(["repo", "view", "--json", "name,owner,url"], { cwd: projectDir, timeout: 15000 });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || "Not a GitHub repo" };
  }
  try {
    const data = JSON.parse(res.stdout);
    return { ok: true, repo: { name: data.name, owner: data.owner.login, url: data.url } };
  } catch {
    return { ok: false, error: "Could not parse GitHub repo info" };
  }
}
