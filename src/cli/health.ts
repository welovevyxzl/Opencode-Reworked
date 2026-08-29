import { loadConfig } from "../storage/index.js";
import { isHealthy } from "../opencode/manager.js";
import { isConnected, getClient } from "../discord/bot.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";
import { resolveDiscordChannel } from "../discord/channels.js";
import * as qs from "../opencode/queue-service.js";
import { getDatabase } from "../storage/index.js";

/**
 * Health monitoring with state transitions (no spam) and recovery messages.
 * Tracks Discord / OpenCode / SQLite / queue worker / current job / git / gh.
 * Notifications go to the configured statusChannelId only — never a random
 * sendable channel.
 */

export type ComponentState = "up" | "down";

interface HealthState {
  opencode: ComponentState;
  database: ComponentState;
  queueWorker: ComponentState;
  git: ComponentState;
  github: ComponentState;
  job: ComponentState;
}

const COOLDOWN_MS = 5 * 60_000;

let last: HealthState = { opencode: "up", database: "up", queueWorker: "up", git: "up", github: "up", job: "up" };
let lastNotify = 0;
let anyOutageSince: number | null = null;

export async function checkHealth(): Promise<void> {
  if (!isConnected()) return;
  const config = loadConfig();
  if (!config) return;

  const next: HealthState = { ...last };

  // OpenCode
  next.opencode = (await ocHealthySafe()) ? "up" : "down";

  // SQLite
  try {
    const db = getDatabase();
    next.database = db ? (db.prepare("SELECT 1").get() ? "up" : "down") : "down";
  } catch {
    next.database = "down";
  }

  // Queue worker: active job must have a fresh heartbeat.
  try {
    const active = qs.getActiveJob();
    if (!active) {
      next.queueWorker = "up";
      next.job = "up";
    } else {
      const hb = active.heartbeatAt ?? active.startedAt ?? active.addedAt;
      const fresh = Date.now() - hb < 2 * 60_000;
      next.queueWorker = fresh ? "up" : "down";
      next.job = fresh ? "up" : "down";
    }
  } catch {
    next.queueWorker = "down";
  }

  // Git + gh (cheap checks, run only when previously down or once per cycle)
  if (last.git === "down" || last.github === "down") {
    try {
      const { runCommand } = await import("../utils/index.js");
      const gitRes = await runCommand("git", ["--version"], { timeout: 5000 });
      next.git = gitRes.code === 0 ? "up" : "down";
      const { isAuthenticated } = await import("../github/index.js");
      next.github = (await isAuthenticated()) ? "up" : "down";
    } catch {
      next.git = "down";
      next.github = "down";
    }
  }

  const changed = (Object.keys(next) as Array<keyof HealthState>).filter((k) => next[k] !== last[k]);
  const nowDown = (Object.keys(next) as Array<keyof HealthState>).filter((k) => next[k] === "down");

  if (nowDown.length > 0 && anyOutageSince === null) anyOutageSince = Date.now();
  if (nowDown.length === 0 && anyOutageSince !== null) {
    // Recovery message after an outage resolves.
    const duration = Math.round((Date.now() - anyOutageSince) / 1000);
    anyOutageSince = null;
    await notify(`✅ OpenCode Remote recovered after ${duration}s. All components healthy.`, config.discord.statusChannelId);
    logInfo("Health recovery notification sent", "health");
  }

  if (changed.length > 0) {
    const parts = changed.map((k) => `${k}: ${last[k]} → ${next[k]}`);
    logWarn(`Health state changed — ${parts.join(", ")}`, "health");
    last = next;

    if (nowDown.length > 0 && Date.now() - lastNotify > COOLDOWN_MS) {
      lastNotify = Date.now();
      const detail = nowDown.map(describeComponent).join("\n");
      await notify(`⚠️ OpenCode Remote component issue:\n${detail}`, config.discord.statusChannelId);
    }
  } else {
    last = next;
  }
}

function describeComponent(key: keyof HealthState): string {
  switch (key) {
    case "opencode":
      return "• **OpenCode** unreachable — the agent server may have crashed. `ocr restart` on the PC or `/doctor` in Discord.";
    case "database":
      return "• **SQLite** — the database is not responding. Check disk space and file locks on `%USERPROFILE%\\.opencode-remote\\data.db`.";
    case "queueWorker":
      return "• **Queue worker** — the current job's heartbeat stopped updating. The watchdog should recover it; `/job current` to inspect.";
    case "job":
      return "• **Current job** — appears stalled (no activity for >10 minutes).";
    case "git":
      return "• **Git** — `git --version` is failing. Reinstall Git or fix PATH.";
    case "github":
      return "• **GitHub CLI** — not authenticated. Run `gh auth login` on the PC.";
    default:
      return `• ${key} is down`;
  }
}

async function notify(message: string, statusChannelId: string | undefined): Promise<void> {
  const client = getClient();
  if (!client) return;
  if (!statusChannelId) {
    logWarn("Health notification skipped: no statusChannelId configured (set it via `ocr config` or setup)", "health");
    return;
  }
  try {
    const channel = await resolveDiscordChannel(statusChannelId);
    if (!channel) {
      logWarn(`Health notification failed: status channel ${statusChannelId} not resolvable`, "health");
      return;
    }
    await channel.send(message);
  } catch (err) {
    logError(`Failed to notify health issue: ${err}`, "health");
  }
}

async function ocHealthySafe(): Promise<boolean> {
  try {
    return await isHealthy();
  } catch {
    return false;
  }
}
