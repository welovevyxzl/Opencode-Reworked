import { disconnect } from "../discord/bot.js";
import { stopServer, isServerOwned } from "../opencode/manager.js";
import { closeDatabase } from "../storage/index.js";
import { logInfo } from "../utils/logger.js";

let stopping = false;

export async function stopGraceful(): Promise<void> {
  if (stopping) return;
  stopping = true;
  logInfo("Graceful shutdown initiated", "cli");

  try {
    await disconnect();
    logInfo("Discord disconnected", "cli");
  } catch (err) {
    logInfo(`Discord disconnect error: ${err}`, "cli");
  }

  try {
    if (isServerOwned()) {
      await stopServer();
      logInfo("OpenCode server stopped (owned by this app)", "cli");
    } else {
      logInfo("OpenCode server left running (not owned by this app)", "cli");
    }
  } catch (err) {
    logInfo(`OpenCode stop error: ${err}`, "cli");
  }

  try {
    closeDatabase();
  } catch (err) {
    logInfo(`Database close error: ${err}`, "cli");
  }
}