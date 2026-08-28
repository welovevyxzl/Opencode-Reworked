import { runCommand } from "../utils/index.js";
import { logWarn } from "../utils/logger.js";

let ghBinary: string | null = null;

export async function findGh(): Promise<string | null> {
  if (ghBinary) return ghBinary;
  if (process.platform === "win32") {
    const { existsSync } = await import("fs");
    const { resolve } = await import("path");
    const pathDirs = (process.env.PATH || "").split(";").filter((p) => p.length > 0);
    for (const dir of pathDirs) {
      for (const shim of [".exe", ".cmd", ""]) {
        const candidate = resolve(dir, "gh" + shim);
        if (existsSync(candidate)) {
          const test = await runCommand(candidate, ["--version"], { timeout: 10000 });
          if (test.code === 0) {
            ghBinary = candidate;
            return candidate;
          }
        }
      }
    }
  } else {
    const res = await runCommand("which", ["gh"], { timeout: 5000 });
    if (res.code === 0) {
      ghBinary = res.stdout.trim();
      return ghBinary;
    }
  }
  return null;
}

export async function isAuthenticated(): Promise<boolean> {
  const gh = await findGh();
  if (!gh) return false;
  const res = await runCommand(gh, ["auth", "status"], { timeout: 15000 });
  return res.code === 0;
}

export async function authStatus(): Promise<{ authenticated: boolean; user?: string; error?: string }> {
  const gh = await findGh();
  if (!gh) {
    return { authenticated: false, error: "GitHub CLI not found. Install gh from https://cli.github.com" };
  }
  const res = await runCommand(gh, ["auth", "status"], { timeout: 15000 });
  if (res.code === 0) {
    const match = res.stdout.match(/Logged in to github\.com as ([^\s(.]+)/);
    return { authenticated: true, user: match ? match[1] : "unknown" };
  }
  return { authenticated: false, error: res.stderr || "Not authenticated with gh" };
}

export async function createRepo(
  name: string,
  opts: { visibility?: "private" | "public"; description?: string } = {}
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const gh = await findGh();
  if (!gh) return { ok: false, error: "GitHub CLI not installed" };
  const args = ["repo", "create", name, "--" + (opts.visibility || "private")];
  if (opts.description) {
    args.push("--description", opts.description);
  }
  args.push("--source=."); // tie to current dir
  const res = await runCommand(gh, args, { timeout: 60000 });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || "Repo creation failed" };
  }
  const urlMatch = res.stdout.match(/https:\/\/github\.com\/[^\s]+/);
  return { ok: true, url: urlMatch ? urlMatch[0] : "https://github.com/" + name };
}

export function repoCreateLocation(opts: { localDir?: string } = {}): string {
  return opts.localDir || ".";
}

export async function createPullRequest(
  opts: {
    title: string;
    body?: string;
    base?: string;
    head?: string;
  }
): Promise<{ ok: boolean; url?: string; error?: string }> {
  const gh = await findGh();
  if (!gh) return { ok: false, error: "GitHub CLI not installed" };
  const args = ["pr", "create", "--title", opts.title];
  if (opts.body) args.push("--body", opts.body);
  if (opts.base) args.push("--base", opts.base);
  if (opts.head) args.push("--head", opts.head);
  const res = await runCommand(gh, args, { timeout: 60000 });
  if (res.code !== 0) {
    return { ok: false, error: res.stderr || "PR creation failed" };
  }
  const urlMatch = res.stdout.match(/https:\/\/github\.com\/[^\s]+/);
  return { ok: true, url: urlMatch ? urlMatch[0] : undefined };
}

export async function listPullRequests(opts: { state?: "open" | "closed" | "all" } = {}): Promise<
  Array<{ number: number; title: string; url: string; state: string }>
> {
  const gh = await findGh();
  if (!gh) return [];
  const args = ["pr", "list", "--state", opts.state || "open", "--json", "number,title,url,state"];
  const res = await runCommand(gh, args, { timeout: 15000 });
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

export async function getRepoInfo(): Promise<{ ok: boolean; repo?: { name: string; owner: string; url: string }; error?: string }> {
  const gh = await findGh();
  if (!gh) return { ok: false, error: "GitHub CLI not installed" };
  const res = await runCommand(gh, ["repo", "view", "--json", "name,owner,url"], { timeout: 15000 });
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