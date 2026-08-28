import { execSync, spawn } from "child_process";
import { existsSync, statSync } from "fs";
import { join, resolve } from "path";

const SHIMS = [".cmd", ".exe", ".ps1", ""];

export function resolveBinary(name: string): string | null {
  if (process.platform === "win32") {
    return resolveWindowsBinary(name);
  }
  return resolveUnixBinary(name);
}

function resolveUnixBinary(name: string): string | null {
  try {
    const result = execSync(`which ${name}`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    if (result && existsSync(result)) {
      return result;
    }
  } catch {
    // fallthrough
  }
  return null;
}

function resolveWindowsBinary(name: string): string {
  const pathDirs = (process.env.PATH || "")
    .split(";")
    .filter((p) => p.length > 0);

  for (const dir of pathDirs) {
    for (const shim of SHIMS) {
      const candidate = resolve(dir, name + shim);
      if (existsSync(candidate)) {
        try {
          execSync(`"${candidate}" --version`, {
            encoding: "utf-8",
            timeout: 10000,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
          });
          return candidate;
        } catch {
          continue;
        }
      }
    }
  }

  const npxPath = resolveWindowsNpx(name);
  if (npxPath) return npxPath;

  throw new Error(
    `Could not resolve ${name}. Ensure it is installed and available in your PATH.`
  );
}

function resolveWindowsNpx(name: string): string | null {
  try {
    const npmPrefix = execSync("npm prefix -g", {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
    const shimPath = join(npmPrefix, name + ".cmd");
    if (existsSync(shimPath)) {
      try {
        execSync(`"${shimPath}" --version`, {
          encoding: "utf-8",
          timeout: 10000,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        return shimPath;
      } catch {
        return null;
      }
    }
  } catch {
    // npm not available
  }
  return null;
}

export function runCommand(
  cmd: string,
  args: string[],
  opts: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      timeout: opts.timeout ?? 30000,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 });
    });

    child.on("error", () => {
      resolve({ stdout: "", stderr: `Failed to start ${cmd}`, code: 1 });
    });
  });
}

export function runPowerShell(
  command: string,
  opts: { timeout?: number } = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runCommand("powershell.exe", ["-NoProfile", "-Command", command], {
    timeout: opts.timeout ?? 15000,
  });
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
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + "...";
}
