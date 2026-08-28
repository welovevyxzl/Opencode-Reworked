import { runCommand, runPowerShell } from "../utils/index.js";
import { logInfo } from "../utils/logger.js";

export interface SystemStatus {
  uptimeMs: number;
  cpuModel: string;
  cores: number;
  totalMemoryGb: number;
  freeMemoryGb: number;
  hostname: string;
  osVersion: string;
  lastBoot: string;
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const os = await import("os");
  const result = {
    uptimeMs: os.uptime() * 1000,
    cpuModel: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    totalMemoryGb: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
    freeMemoryGb: Math.round(os.freemem() / 1024 / 1024 / 1024 * 10) / 10,
    hostname: os.hostname(),
    osVersion: `${os.type()} ${os.release()}`,
    lastBoot: "",
  };

  if (process.platform === "win32") {
    const res = await runPowerShell("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('yyyy-MM-dd HH:mm:ss')");
    if (res.code === 0) result.lastBoot = res.stdout.trim();
  }
  return result;
}

export async function lockScreen(): Promise<{ ok: boolean; error?: string }> {
  logInfo("Locking screen", "system");
  try {
    const res = await runCommand("rundll32.exe", ["user32.dll,LockWorkStation"], { timeout: 5000 });
    return { ok: res.code === 0, error: res.stderr || undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function sleep(): Promise<{ ok: boolean; error?: string }> {
  logInfo("Sleeping system", "system");
  try {
    const res = await runCommand("rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"], { timeout: 5000 });
    return { ok: res.code === 0, error: res.stderr || undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function restart(): Promise<{ ok: boolean; error?: string }> {
  logInfo("Restarting system", "system");
  try {
    const res = await runPowerShell("Shutdown /r /t 15 /c 'OpenCode Remote requested restart'");
    return { ok: res.code === 0, error: res.stderr || undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function shutdown(): Promise<{ ok: boolean; error?: string }> {
  logInfo("Shutting down system", "system");
  try {
    const res = await runPowerShell("Shutdown /s /t 15 /c 'OpenCode Remote requested shutdown'");
    return { ok: res.code === 0, error: res.stderr || undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function cancelShutdown(): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await runPowerShell("Shutdown /a");
    return { ok: res.code === 0, error: res.stderr || undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export function getNodeInfo(): { version: string; platform: string } {
  return { version: process.version, platform: process.platform };
}

export interface PortInfo {
  port: number;
  inUse: boolean;
  pid?: number;
  processName?: string;
}

export async function checkPort(port: number): Promise<PortInfo> {
  if (process.platform === "win32") {
    const res = await runCommand("netstat", ["-ano"], { timeout: 10000 });
    const pattern = new RegExp(`TCP\\s+\\S+:${port}\\s+\\S+:\\S+\\s+LISTENING\\s+(\\d+)`);
    const match = res.stdout.match(pattern);
    if (!match) return { port, inUse: false };

    const pid = parseInt(match[1], 10);
    let processName = "";
    if (pid > 0) {
      const taskRes = await runCommand("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { timeout: 10000 });
      const nameMatch = taskRes.stdout.match(/^"([^"]+)"/);
      processName = nameMatch ? nameMatch[1] : String(pid);
    }
    return { port, inUse: true, pid, processName };
  }
  return { port, inUse: false };
}

export async function getPortRange(min: number, max: number): Promise<PortInfo[]> {
  const results: PortInfo[] = [];
  for (let p = min; p <= max; p++) {
    results.push(await checkPort(p));
  }
  return results;
}

export async function findFreePort(preferred: number, range?: [number, number]): Promise<number> {
  const info = await checkPort(preferred);
  if (!info.inUse) return preferred;
  if (!range) return preferred;

  for (let p = range[0]; p <= range[1]; p++) {
    if (p === preferred) continue;
    const check = await checkPort(p);
    if (!check.inUse) return p;
  }
  return preferred;
}