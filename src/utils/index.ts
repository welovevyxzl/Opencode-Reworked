import { spawn } from "child_process";
import { existsSync, statSync, readdirSync } from "fs";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Binary resolution — contract: return null when not found; throw only on
// unexpected filesystem errors. No shell execution during resolution.
// ---------------------------------------------------------------------------

export function resolveBinary(name: string): string | null {
  if (process.platform === "win32") {
    return resolveWindowsBinary(name);
  }
  return resolveUnixBinary(name);
}

function resolveUnixBinary(name: string): string | null {
  const pathDirs = (process.env.PATH || "").split(":").filter((p) => p.length > 0);
  for (const dir of pathDirs) {
    const candidate = resolve(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (err) {
      if (isPermissionError(err)) throw err;
    }
  }
  return null;
}

function isPermissionError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  return e?.code === "EACCES" || e?.code === "EPERM";
}

function resolveWindowsBinary(name: string): string | null {
  const pathDirs = (process.env.PATH || "").split(";").filter((p) => p.length > 0);
  const pathExt = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  // Prefer real executables over script shims: .EXE first, .CMD last.
  const extOrder = [...pathExt].sort((a, b) => {
    const rank = (ext: string) => (ext.toUpperCase() === ".EXE" ? 0 : ext.toUpperCase() === ".COM" ? 1 : ext.toUpperCase() === ".CMD" || ext.toUpperCase() === ".BAT" ? 3 : 2);
    return rank(a) - rank(b);
  });
  const hasExt = /\.[a-z0-9]+$/i.test(name);

  for (const dir of pathDirs) {
    try {
      if (hasExt) {
        const candidate = resolve(dir, name);
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } else {
        for (const ext of extOrder) {
          const candidate = resolve(dir, name + ext.toLowerCase());
          if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
          const upper = resolve(dir, name + ext.toUpperCase());
          if (upper !== candidate && existsSync(upper) && statSync(upper).isFile()) return upper;
        }
      }
    } catch (err) {
      if (isPermissionError(err)) throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Windows-safe process spawning
// ---------------------------------------------------------------------------

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
  s = s.replace(/([()\][!^"`%&<>|;,*?=])/g, "^$1");
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
      // Never enable shell:true with user data. Route .cmd/.bat through
      // cmd.exe with fully escaped arguments instead.
      const combined = [escapeWindowsCmdArg(cmd), ...args.map((a) => escapeWindowsCmdArg(a))].join(" ");
      child = spawn("cmd.exe", ["/d", "/s", "/c", combined], {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 30000,
        env: { ...process.env, ...opts.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: false,
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
