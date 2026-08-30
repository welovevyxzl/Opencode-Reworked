import { spawn } from "child_process";
import { existsSync, statSync, readdirSync } from "fs";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Binary resolution — contract: return null when not found; throw only on
// unexpected filesystem errors. No shell execution during resolution.
// ---------------------------------------------------------------------------

/**
 * Return the first PATH-resolvable candidate for `name` (or null). This keeps
 * the historical single-result contract for callers that only need "the
 * binary"; consumers that need to try several candidates should use
 * listResolvedBinaries() instead.
 */
export function resolveBinary(name: string): string | null {
  const list = listResolvedBinaries(name);
  return list.length > 0 ? list[0] : null;
}

/**
 * Enumerate every PATH-resolvable candidate for `name`, in preference order.
 * - Windows: walks PATH and PATHEXT (real executables .EXE/.COM before .cmd/.bat
 *   shims), plus the standard npm global shim directories so that npm-global
 *   installs are found even if the running process' PATH omits them.
 * - Unix: walks PATH looking for an executable of exactly `name`.
 * Deduplicates by normalized path so the same file is never returned twice.
 * Never executes anything and throws only on unexpected permission errors.
 */
export function listResolvedBinaries(name: string): string[] {
  if (process.platform === "win32") {
    return listWindowsBinaries(name);
  }
  return listUnixBinaries(name);
}

function listUnixBinaries(name: string): string[] {
  const out: string[] = [];
  const pathDirs = (process.env.PATH || "").split(":").filter((p) => p.length > 0);
  for (const dir of pathDirs) {
    const candidate = resolve(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile() && !out.includes(candidate)) {
        out.push(candidate);
      }
    } catch (err) {
      if (isPermissionError(err)) throw err;
    }
  }
  return out;
}

function isPermissionError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === "EACCES" || e?.code === "EPERM";
}

function windowsExtOrder(): string[] {
  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const rank = (ext: string) => {
    const e = ext.toUpperCase();
    if (e === ".EXE") return 0;
    if (e === ".COM") return 1;
    if (e === ".BAT") return 3;
    if (e === ".CMD") return 4;
    return 2;
  };
  return [...pathExt].sort((a, b) => rank(a) - rank(b));
}

/** Standard npm global shim locations (e.g. %APPDATA%\npm\opencode.cmd). */
function npmGlobalDirs(): string[] {
  const out: string[] = [];
  const pushEnv = (envVar: string, ...tail: string[]) => {
    const base = process.env[envVar];
    if (base) out.push(join(base, ...tail));
  };
  pushEnv("APPDATA", "npm");
  pushEnv("USERPROFILE", "AppData", "Roaming", "npm");
  return out;
}

function listWindowsBinaries(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (candidate: string) => {
    const norm = candidate.toLowerCase();
    if (seen.has(norm)) return;
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        seen.add(norm);
        out.push(candidate);
      }
    } catch (err) {
      if (isPermissionError(err)) throw err;
    }
  };

  const hasExt = /\.[a-z0-9]+$/i.test(name);
  const dirs = [
    ...(process.env.PATH || "").split(";").filter((p) => p.length > 0),
    ...npmGlobalDirs(),
  ];

  for (const dir of dirs) {
    if (hasExt) {
      push(resolve(dir, name));
    } else {
      for (const ext of windowsExtOrder()) {
        // Case-insensitive filesystems: try lower then upper so a shim that was
        // installed with either casing is found; `seen` de-duplicates the pair.
        push(resolve(dir, name + ext.toLowerCase()));
        const upper = resolve(dir, name + ext.toUpperCase());
        if (upper.toLowerCase() !== resolve(dir, name + ext.toLowerCase()).toLowerCase()) {
          push(upper);
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Windows-safe process spawning
// ---------------------------------------------------------------------------

/**
 * Escape a .cmd/.bat command path for cmd.exe `/c` invocation, mirroring
 * cross-spawn's escapeCommand: caret-escape cmd metacharacters (including
 * spaces) WITHOUT wrapping in quotes, so the path stays a single token and can
 * be grouped by the single outer quote wrapper added by the caller.
 */
function escapeWindowsCmd(cmd: string): string {
  return cmd.replace(/([()\][!^"`%&<>|;,*?= ])/g, "^$1");
}

/**
 * Escape a single argument for cmd.exe `/c` invocation. Algorithm mirrors the
 * battle-tested cross-spawn escaping: quote the argument, then caret-escape
 * cmd metacharacters. Prevents argument injection through .cmd shims.
 */
function escapeWindowsCmdArg(arg: string, doubleEscape = false): string {
  let s = `${arg}`;
  // Double up trailing backslashes and escape embedded quotes for the quoted form.
  s = s.replace(/(\\*)"/g, '$1$1\\"');
  s = s.replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  // Caret-escape cmd metacharacters (inside quotes cmd still special-cases some).
  s = s.replace(/([()\][!^"`%&<>|;,*?= ])/g, "^$1");
  if (doubleEscape) {
    s = s.replace(/(%)/g, "^$1");
  }
  return s;
}

function isCmdShim(cmd: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(cmd);
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  } = {}
): Promise<RunCommandResult> {
  // Newlines in arguments enable header/option injection on many CLIs.
  for (const a of args) {
    if (/[\r\n]/.test(a)) {
      return Promise.resolve({
        stdout: "",
        stderr: `Rejected argument containing newline: ${a.slice(0, 60)}`,
        code: 1,
      });
    }
  }

  return new Promise((resolvePromise) => {
    let child;
    if (isCmdShim(cmd)) {
      // Never enable shell:true with user data. Route .cmd/.bat through cmd.exe
      // /d /s /c mirroring cross-spawn's proven construction: caret-escape the
      // bare command path and each escaped arg, join them, then wrap the whole
      // command line in a SINGLE outer pair of quotes that /s strips back down.
      // The command must be an absolute path (ComSpec) because a freshly set
      // PATH may not contain cmd.exe.
      const shellCommand = [escapeWindowsCmd(cmd), ...args.map((a) => escapeWindowsCmdArg(a))].join(" ");
      child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${shellCommand}"`], {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 30000,
        env: { ...process.env, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
    } else {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 30000,
        env: { ...process.env, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    }

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolvePromise({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
    });

    child.on("error", (err) => {
      resolvePromise({ stdout: "", stderr: `Failed to start ${cmd}: ${String(err)}`, code: 1 });
    });
  });
}

export function runPowerShell(
  command: string,
  opts: { timeout?: number } = {}
): Promise<RunCommandResult> {
  // resolveBinary walks PATH (preferring .exe), which beats spawn's SearchPath.
  // On Windows the WindowsPowerShell dir is often absent from PATH, so fall
  // back to the standard install locations too.
  const bin =
    resolveBinary("powershell") ?? resolveBinary("pwsh") ?? findWindowsPowerShell();
  if (!bin) {
    return Promise.resolve({
      stdout: "",
      stderr: "PowerShell not found on PATH (expected powershell.exe or pwsh)",
      code: 1,
    });
  }
  return runCommand(bin, ["-NoProfile", "-Command", command], {
    timeout: opts.timeout ?? 15000,
  });
}

function findWindowsPowerShell(): string | null {
  if (process.platform !== "win32") return null;
  const sysRoot = process.env.SystemRoot || "C:\\Windows";
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const candidates = [
    join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    join(programFiles, "PowerShell", "7", "pwsh.exe"),
    join(programFilesX86, "PowerShell", "7", "pwsh.exe"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore unreadable paths
    }
  }
  return null;
}

export function isValidPath(p: string): boolean {
  if (!p || p.trim().length === 0) return false;
  try {
    const s = statSync(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

export function safePath(p: string): string {
  return resolve(p.replace(/\//g, "\\"));
}

export function getPlatform(): string {
  return `${process.platform} ${process.arch}`;
}

export function getNodeVersion(): string {
  return process.version;
}

export function getMemoryUsage(): { used: number; total: number } {
  const mem = process.memoryUsage();
  return {
    used: Math.round(mem.heapUsed / 1024 / 1024),
    total: Math.round(mem.heapTotal / 1024 / 1024),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function generateId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}

/** List files in a directory (non-recursive), throwing fs errors upward. */
export function listDirSafe(dir: string): string[] {
  return readdirSync(dir);
}
