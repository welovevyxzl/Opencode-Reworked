import { loadConfig, initDatabase } from "../storage/index.js";
import { initLogger, logError } from "../utils/logger.js";
import { startOpenCodeAndDiscord, getBotStatus } from "../discord/bot.js";
import { configure, getServerInfo } from "../opencode/manager.js";
import { configOpenCodeManager } from "../opencode/engine.js";
import { Icons } from "../discord/ui.js";
import { stopGraceful } from "./graceful.js";
import { checkHealth } from "./health.js";

export async function startBot(): Promise<void> {
  initLogger("INFO");
  const config = loadConfig();
  if (!config) {
    console.log("  No configuration found. Run `ocr setup` first.");
    return;
  }

  initDatabase();
  configure(config);
  configOpenCodeManager();

  console.log();
  console.log("  OpenCode Remote");
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
    // keep process alive; periodic health check happens here
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
  await stopGraceful();
  await startBot();
}