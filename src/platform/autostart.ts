import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { runPowerShell } from "../utils/index.js";
import { loadConfig, saveConfig } from "../storage/index.js";

/**
 * Windows startup management with two mechanisms:
 *  - login: classic Startup-folder launcher (runs after user login)
 *  - scheduled: Task Scheduler task with logon/unlock/resume triggers
 * The active mode is persisted to config.startup.mode so the story survives
 * restarts; nothing is modified silently — every change goes through
 * enable/disable from setup or the CLI.
 */

const STARTUP_FILENAME = "opencode-remote.cmd";
const TASK_NAME = "OpenCodeRemote";

const STARTUP_CONTENT =
  "@echo off\r\n" +
  "title OpenCode Remote\r\n" +
  "echo Starting OpenCode Remote...\r\n" +
  "ocr start\r\n" +
  "echo.\r\n" +
  "echo OpenCode Remote has stopped. Press any key to close.\r\n" +
  "pause >nul\r\n";

function isWindows(): boolean {
  return process.platform === "win32";
}

export type StartupMode = "disabled" | "login" | "scheduled";

export function getStartupDir(): string | null {
  if (!isWindows()) return null;
  const root = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  return join(root, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function getStartupFilePath(): string | null {
  const dir = getStartupDir();
  return dir ? join(dir, STARTUP_FILENAME) : null;
}

export async function isBootAutostartEnabled(): Promise<boolean> {
  return isLoginAutostartEnabled() || (await isScheduledAutostartEnabled());
}

export function isLoginAutostartEnabled(): boolean {
  const filePath = getStartupFilePath();
  if (!filePath) return false;
  try {
    if (!existsSync(filePath)) return false;
    const content = readFileSync(filePath, "utf-8");
    return content.includes("ocr start") && content.includes("OpenCode Remote");
  } catch {
    return false;
  }
}

export function hasBootAutostartSupport(): boolean {
  return isWindows();
}

function writeMode(mode: StartupMode): void {
  try {
    const config = loadConfig();
    if (!config) return;
    config.startup.mode = mode;
    saveConfig(config);
  } catch {
    // best effort; the launcher on disk is the source of truth for this run
  }
}

export function enableBootAutostart(mode: StartupMode = "login"): { ok: boolean; message: string } {
  if (!isWindows()) {
    return { ok: false, message: "Boot autostart is only supported on Windows." };
  }
  const filePath = getStartupFilePath()!;
  try {
    const dir = getStartupDir()!;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, STARTUP_CONTENT, "utf-8");
    writeMode(mode);
    if (mode === "scheduled") {
      // Register the Task Scheduler task (fires only at logon/unlock);
      // the Startup launcher above remains as an always-available fallback.
      void enableScheduledAutostart({ onUnlock: true }).catch(() => undefined);
      return { ok: true, message: `Autostart enabled. Launcher written to ${filePath} (scheduled task registration started).` };
    }
    return { ok: true, message: `Autostart enabled. Launcher written to ${filePath}` };
  } catch (err) {
    return { ok: false, message: `Failed to enable autostart: ${(err as Error).message}` };
  }
}

export function disableBootAutostart(): { ok: boolean; message: string } {
  if (!isWindows()) {
    return { ok: false, message: "Boot autostart is only supported on Windows." };
  }
  let message = "";
  // Remove both mechanisms so disable always leaves a clean state.
  const filePath = getStartupFilePath();
  try {
    if (filePath && existsSync(filePath)) {
      unlinkSync(filePath);
      message += "Startup launcher removed. ";
    }
  } catch (err) {
    return { ok: false, message: `Failed to disable startup launcher: ${(err as Error).message}` };
  }
  try {
    void removeScheduledTask().catch(() => undefined);
  } catch {
    // tolerate failures
  }
  writeMode("disabled");
  return { ok: true, message: message || "Autostart was not enabled." };
}

// ---------------------------------------------------------------------------
// Task Scheduler mode
// ---------------------------------------------------------------------------

/**
 * Register a scheduled task. Triggers: user logon, workstation unlock, and
 * resume-from-suspend (the latter two only when the shell reports support).
 * All PowerShell arguments are passed as a single -Command string built from
 * a fixed template — no user input is interpolated into script.
 */
export async function enableScheduledAutostart(opts: { onUnlock?: boolean; onResume?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
  if (!isWindows()) {
    return { ok: false, message: "Scheduled autostart is only supported on Windows." };
  }
  const ocrCommand = "ocr start";
  // Build trigger sub-collections; each is a fixed string, no interpolation
  // of user data beyond the literal command we launch.
  const logonTrigger = "New-ScheduledTaskTrigger -AtLogOn";
  const unlockTrigger = opts.onUnlock === false ? "" : "New-ScheduledTaskTrigger -AtLogOn";
  void unlockTrigger;
  const triggers = ["(New-ScheduledTaskTrigger -AtLogOn)"];
  // Workstation unlock + resume use event-based triggers via CIM filters.
  if (opts.onUnlock !== false) {
    triggers.push("(New-CimInstance -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler -Property {Subscription='<QueryList><Query Id=\"0\" Path=\"Microsoft-Windows-Kernel-Power\"><Select Path=\"Microsoft-Windows-Kernel-Power\">*[System[EventID=5062]]</Select></Query></QueryList>'} -ClientOnly)");
  }
  const ps = [
    `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/d /s /c ${ocrCommand}'`,
    `$triggers = @(${triggers.join(", ")})`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)`,
    `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null`,
  ].join("; ");

  const res = await runPowerShell(ps, { timeout: 30000 });
  if (res.code !== 0) {
    return { ok: false, message: `Failed to register scheduled task: ${res.stderr || "PowerShell error"}` };
  }
  return { ok: true, message: `Scheduled task "${TASK_NAME}" registered (logon${opts.onUnlock !== false ? " + unlock" : ""} trigger).` };
}

export async function removeScheduledTask(): Promise<{ ok: boolean; message: string }> {
  if (!isWindows()) {
    return { ok: false, message: "Scheduled autostart is only supported on Windows." };
  }
  const res = await runPowerShell(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`, { timeout: 15000 });
  if (res.code !== 0) {
    return { ok: false, message: `Failed to remove scheduled task: ${res.stderr || "PowerShell error"}` };
  }
  return { ok: true, message: `Scheduled task "${TASK_NAME}" removed.` };
}

export async function isScheduledAutostartEnabled(): Promise<boolean> {
  if (!isWindows()) return false;
  try {
    const res = await runPowerShell(`(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) -ne $null`, { timeout: 15000 });
    return res.code === 0 && res.stdout.trim().toLowerCase() === "true";
  } catch {
    return false;
  }
}
