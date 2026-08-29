import { getBotStatus } from "../discord/bot.js";
import { isHealthy, getServerInfo, isUnhealthy, getBinaryPath } from "../opencode/manager.js";
import * as qs from "../opencode/queue-service.js";
import { loadConfig, initDatabase, closeDatabase } from "../storage/index.js";
import { getMemoryUsage } from "../utils/index.js";
import { Icons } from "../discord/ui.js";
import { formatBuildSummary } from "../utils/build-info.js";

export async function printStatus(): Promise<void> {
  const config = loadConfig();
  initDatabase();
  try {
    const bot = getBotStatus();
    let oc = false;
    if (config) {
      try {
        oc = await isHealthy();
      } catch {
        oc = false;
      }
    }
    const stats = qs.getQueueStats();
    const mem = getMemoryUsage();
    const server = getServerInfo();

    console.log();
    console.log(`  OpenCode Remote — status  ${formatBuildSummary()}`);
    console.log("  " + "─".repeat(32));
    if (config) {
      console.log(`  Discord     ${bot.connected ? Icons.running + " connected as " + bot.tag : Icons.fail + " not connected"}`);
      console.log(`  OpenCode    ${oc ? Icons.running + " healthy" : isUnhealthy() ? Icons.fail + " unhealthy" : Icons.idle + " not reachable"}${binarySuffix()}`);
      console.log(`  API         ${server.host}:${server.port}`);
      console.log(`  Projects    ${config.projects.registered.length} registered`);
      console.log(`  Queue       ${stats.queued} queued / ${stats.active} active${stats.paused ? " / PAUSED" : ""}`);
      console.log(`  Memory      ${mem.used} MB heap`);
      console.log(`  Node        ${process.version}`);
    } else {
      console.log(`  Configuration missing. Run \`ocr setup\`.`);
    }
    console.log();
  } finally {
    closeDatabase();
  }
}

function binarySuffix(): string {
  const bin = getBinaryPath();
  return bin ? ` (${bin})` : "";
}
