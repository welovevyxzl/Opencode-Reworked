import { loadConfig, saveConfig } from "../storage/index.js";
import {
  enableBootAutostart,
  disableBootAutostart,
  enableScheduledAutostart,
  removeScheduledTask,
  isLoginAutostartEnabled,
  isScheduledAutostartEnabled,
  hasBootAutostartSupport,
  getStartupFilePath,
  type StartupMode,
} from "../platform/autostart.js";

type Action = "enable" | "disable" | "status" | "login" | "scheduled" | undefined;

/**
 * `ocr autostart` — modes:
 *   disabled  nothing runs at boot
 *   login     Startup-folder launcher (runs after login)
 *   scheduled Task Scheduler task (logon + optional unlock/resume triggers)
 * Nothing is modified silently: each subcommand states exactly what changed.
 */
export async function handleAutostart(action: Action): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("  No configuration found. Run `ocr setup` first.");
    return;
  }

  if (!hasBootAutostartSupport()) {
    console.log("  Boot autostart is only supported on Windows.");
    return;
  }

  const mode: StartupMode = (config.startup.mode as StartupMode) ?? (config.startup.bootWithWindows ? "login" : "disabled");

  if (!action || action === "status") {
    const scheduledEnabled = await isScheduledAutostartEnabled();
    console.log();
    console.log("  Boot autostart");
    console.log("  " + "─".repeat(20));
    console.log(`    Mode            : ${mode}`);
    console.log(`    Startup launcher: ${isLoginAutostartEnabled() ? "installed" : "not installed"}`);
    console.log(`    Scheduled task  : ${scheduledEnabled ? "registered" : "not registered"}`);
    const path = getStartupFilePath();
    if (path) console.log(`    Launcher path   : ${path}`);
    console.log();
    console.log("  Usage: ocr autostart login | scheduled | disable | status");
    console.log();
    return;
  }

  if (action === "login") {
    const result = enableBootAutostart();
    if (result.ok) {
      // A login launcher replaces a scheduled task for clarity.
      if (await isScheduledAutostartEnabled()) await removeScheduledTask();
      config.startup.mode = "login";
      config.startup.bootWithWindows = true;
      saveConfig(config);
      console.log(`  ✓ ${result.message}`);
    } else {
      console.log(`  ✗ ${result.message}`);
    }
    return;
  }

  if (action === "scheduled") {
    const result = await enableScheduledAutostart({ onUnlock: true });
    if (result.ok) {
      // Remove the Startup launcher so only one mechanism is active.
      const filePath = getStartupFilePath();
      if (filePath && isLoginAutostartEnabled()) await disableBootAutostart();
      config.startup.mode = "scheduled";
      config.startup.bootWithWindows = true;
      saveConfig(config);
      console.log(`  ✓ ${result.message}`);
    } else {
      console.log(`  ✗ ${result.message}`);
    }
    return;
  }

  if (action === "enable") {
    // Legacy alias: enable = login mode.
    const result = enableBootAutostart();
    if (result.ok) {
      config.startup.mode = "login";
      config.startup.bootWithWindows = true;
      saveConfig(config);
      console.log(`  ✓ ${result.message}`);
    } else {
      console.log(`  ✗ ${result.message}`);
    }
    return;
  }

  if (action === "disable") {
    const result = disableBootAutostart();
    config.startup.mode = "disabled";
    config.startup.bootWithWindows = false;
    saveConfig(config);
    console.log(`  ✓ ${result.message}`);
    return;
  }

  console.log(`  Unknown autostart action: ${action}`);
  console.log("  Usage: ocr autostart [login|scheduled|enable|disable|status]");
}
