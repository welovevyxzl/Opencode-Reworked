import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { runCommand } from "../utils/index.js";
import { logInfo, logJobEvent } from "../utils/logger.js";

/**
 * Verification loop. Determines the commands a project supports from its
 * package.json (or build config) instead of hardcoding assumptions, runs
 * them in the project directory, and returns structured results so the
 * engine can report real verification outcomes — never claim success unless
 * a command actually ran and exited 0.
 */

export interface VerificationCommand {
  label: string;
  command: string;
  args: string[];
  required: boolean;
}

export interface VerificationResult {
  label: string;
  ran: boolean;
  ok: boolean;
  required: boolean;
  exitCode: number | null;
  output: string;
  error?: string;
}

export interface VerificationReport {
  projectDir: string;
  results: VerificationResult[];
  allRequiredPassed: boolean;
  anyRan: boolean;
  summary: string;
}

interface PackageScripts {
  scripts?: Record<string, string>;
}

export function detectVerificationCommands(projectDir: string): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  const pkgPath = join(projectDir, "package.json");
  let scripts: Record<string, string> = {};

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as PackageScripts;
      scripts = pkg.scripts ?? {};
    } catch {
      scripts = {};
    }
  }

  const hasScript = (name: string) => typeof scripts[name] === "string" && scripts[name].trim().length > 0;

  if (hasScript("build")) commands.push({ label: "build", command: "npm", args: ["run", "build"], required: true });
  if (hasScript("typecheck")) commands.push({ label: "typecheck", command: "npm", args: ["run", "typecheck"], required: true });
  if (hasScript("test")) commands.push({ label: "test", command: "npm", args: ["test"], required: false });
  if (hasScript("lint")) commands.push({ label: "lint", command: "npm", args: ["run", "lint"], required: false });

  // Python projects
  if (existsSync(join(projectDir, "pyproject.toml"))) {
    commands.push({ label: "pytest", command: "python", args: ["-m", "pytest", "--tb=short"], required: false });
  }
  // Go projects
  if (existsSync(join(projectDir, "go.mod"))) {
    commands.push({ label: "go build", command: "go", args: ["build", "./..."], required: true });
    commands.push({ label: "go test", command: "go", args: ["test", "./..."], required: false });
  }
  // Rust projects
  if (existsSync(join(projectDir, "Cargo.toml"))) {
    commands.push({ label: "cargo check", command: "cargo", args: ["check", "--quiet"], required: true });
  }

  return commands;
}

export async function runVerification(
  projectDir: string,
  jobId: string | undefined,
  opts: { timeoutMs?: number } = {}
): Promise<VerificationReport> {
  const commands = detectVerificationCommands(projectDir);
  const results: VerificationResult[] = [];

  for (const cmd of commands) {
    const res = await runCommand(cmd.command, cmd.args, {
      cwd: projectDir,
      timeout: opts.timeoutMs ?? 5 * 60_000,
    });
    const combined = (res.stdout + (res.stderr ? `\n${res.stderr}` : "")).trim();
    results.push({
      label: cmd.label,
      ran: true,
      ok: res.code === 0,
      required: cmd.required,
      exitCode: res.code,
      output: combined.length > 1200 ? combined.slice(0, 600) + "\n…\n" + combined.slice(-500) : combined,
      error: res.code === 0 ? undefined : `${cmd.command} ${cmd.args.join(" ")} exited with ${res.code}`,
    });
    if (jobId) {
      logJobEvent(res.code === 0 ? "INFO" : "WARN", "VERIFY", jobId ?? "", `${cmd.label}: ${res.code === 0 ? "passed" : "failed"}`);
    }
  }

  const anyRan = results.some((r) => r.ran);
  const allRequiredPassed = results.filter((r) => r.required || r.label === "test").every((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const summary = !anyRan
    ? "No verification commands detected for this project."
    : failed.length === 0
      ? `All ${results.length} verification step(s) passed.`
      : `Failed: ${failed.map((f) => f.label).join(", ")}`;

  if (!anyRan) logInfo("No verification commands detected", "verify", { projectDir });
  return { projectDir, results, allRequiredPassed, anyRan, summary };
}
