import { loadConfig, initDatabase, cleanupExpiredPendingActions } from "../storage/index.js";
import { initLogger, logInfo, logWarn, logError } from "../utils/logger.js";
import { startOpenCodeAndDiscord, getBotStatus } from "../discord/bot.js";
import { configure, getServerInfo } from "../opencode/manager.js";
import { initEngine, recoverOnStartup, configOpenCodeManager } from "../opencode/engine.js";
import { initQueueService, getQueueStats } from "../opencode/queue-service.js";
import { recoverTasksOnStartup } from "../opencode/task-runner.js";
import { Icons } from "../discord/ui.js";
import { getBuildInfo, formatBuildSummary } from "../utils/build-info.js";
import { stopGraceful } from "./graceful.js";
import { checkHealth } from "./health.js";
import { enableBootAutostart, hasBootAutostartSupport, isBootAutostartEnabled } from "../platform/autostart.js";

export async function startBot(): Promise<void> {
  initLogger("INFO");
  const config = loadConfig();
  if (!config) {
    console.log("  No configuration found. Run `ocr setup` first.");
    return;
  }

  const build = getBuildInfo();
  if (build.runningFrom === "dist" && build.sourceChangedSinceBuild) {
    console.log("  ⚠ Source has changed since the last build. Run `npm run build` (or use `ocr restart`, which rebuilds).");
  }

  initDatabase();
  configure(config);
  configOpenCodeManager();
  initQueueService();
  initEngine();

  // Recover queue + tasks from SQLite before touching Discord.
  try {
    const recovered = await recoverOnStartup();
    if (recovered.inspected > 0) {
      logWarn(
        `Startup recovery: ${recovered.requeued.length} requeued, ${recovered.interrupted.length} interrupted, ${recovered.cancelled.length} cancelled`,
        "cli"
      );
    }
    const tasksRecovered = recoverTasksOnStartup();
    if (tasksRecovered.resumed > 0 || tasksRecovered.paused > 0) {
      logInfo(`Task recovery: ${tasksRecovered.resumed} resumed, ${tasksRecovered.paused} paused`, "cli");
    }
    const purged = cleanupExpiredPendingActions();
    if (purged > 0) logInfo(`Purged ${purged} expired pending action(s)`, "cli");
  } catch (err) {
    logError(`Startup recovery failed: ${String(err)}`, "cli");
  }

  if (config.startup.bootWithWindows && hasBootAutostartSupport() && !(await isBootAutostartEnabled())) {
    const r = enableBootAutostart();
    console.log(r.ok ? `  ${Icons.running} Boot autostart launcher ensured` : `  ${Icons.idle} ${r.message}`);
  }

  console.log();
  console.log("  OpenCode Remote");
  console.log(`  ${formatBuildSummary()}`);
  console.log("  " + "─".repeat(32));

  const result = await startOpenCodeAndDiscord();

  if (result.discord) {
    const status = getBotStatus();
    console.log(`  Discord     ${Icons.running} connected as ${status.tag}`);
  } else {
    console.log(`  Discord     ${Icons.fail} failed`);
  }

  if (result.opencode) {
    const server = getServerInfo();
    console.log(`  OpenCode    ${Icons.running} running`);
    console.log(`  API         ${server.host}:${server.port}`);
  } else {
    console.log(`  OpenCode    ${Icons.idle} ${result.messages.join("; ")}`);
  }

  const stats = getQueueStats();
  console.log(`  Queue       ${stats.queued} queued · ${stats.active} active${stats.paused ? " · PAUSED" : ""}`);
  const registered = config.projects.registered.length;
  console.log(`  Projects    ${registered}`);
  console.log(`  Owner       ${config.discord.ownerId ? "configured" : "missing"}`);
  console.log();
  console.log("  Ready.");
  console.log();

  installSignalHandlers();
  void watchUptimeLoop();
}

function installSignalHandlers(): void {
  process.on("SIGINT", () => {
    console.log("\n  Shutting down gracefully...");
    void stopGraceful().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    console.log("\n  Received SIGTERM, shutting down...");
    void stopGraceful().then(() => process.exit(0));
  });
  process.on("uncaughtException", (err) => {
    logError(`Uncaught exception: ${String(err?.stack ?? err)}`, "cli");
  });
  process.on("unhandledRejection", (reason) => {
    logError(`Unhandled rejection: ${String(reason)}`, "cli");
  });
}

async function watchUptimeLoop(): Promise<void> {
  setInterval(() => {
    void checkHealth();
  }, 30000);
}

export async function stopBot(): Promise<void> {
  initLogger("INFO");
  await stopGraceful();
  console.log("  Bot stopped.");
}

export async function restartBot(): Promise<void> {
  initLogger("INFO");
  console.log("  Restarting...");
  const { ensureFreshBuild } = await import("./build-check.js");
  const buildOk = await ensureFreshBuild({ auto: true });
  if (!buildOk) {
    console.log("  Source has changed since the last build. Run `npm run build`.");
    process.exitCode = 1;
    return;
  }
  await stopGraceful();
  await startBot();
}
