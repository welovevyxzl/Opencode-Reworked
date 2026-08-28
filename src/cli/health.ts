import { loadConfig } from "../storage/index.js";
import { isHealthy } from "../opencode/manager.js";
import { isConnected, getClient } from "../discord/bot.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";

let lastKnownHealthy = false;
let notifyCooldown = 0;

export async function checkHealth(): Promise<void> {
  if (!isConnected()) return;

  const config = loadConfig();
  if (!config) return;

  const healthy = await ocHealthySafe();

  if (healthy !== lastKnownHealthy) {
    if (!healthy) {
      logWarn("OpenCode became unreachable during health check", "health");
      notifyCooldown = Date.now() + 60000;
    } else {
      logInfo("OpenCode reachable again", "health");
    }
    lastKnownHealthy = healthy;
  }

  if (!healthy && Date.now() > notifyCooldown) {
    notifyHealthIssue();
    notifyCooldown = Date.now() + 120000;
  }
}

async function ocHealthySafe(): Promise<boolean> {
  try {
    return await isHealthy();
  } catch {
    return false;
  }
}

function notifyHealthIssue(): void {
  const client = getClient();
  if (!client) return;
  const config = loadConfig();
  if (!config) return;
  const channelId = config.discord.guildId;
  if (!channelId) return;
  try {
    const channel = client.channels.cache.find(
      (c) => c.isTextBased() && "guildId" in c && c.guildId === channelId && "send" in c
    ) as { send: (m: string) => Promise<unknown> } | undefined;
    if (channel) {
      channel.send("⚠️ OpenCode became unreachable. The bot is still running; check `oc doctor` for details.").catch(() => undefined);
    }
  } catch (err) {
    logError(`Failed to notify health issue: ${err}`, "health");
  }
}