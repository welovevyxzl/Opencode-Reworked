import { loadConfig, getAllowlist } from "../storage/index.js";
import { sanitizeToken } from "../security/auth.js";
import { getServerInfo } from "../opencode/manager.js";
import { isBootAutostartEnabled, hasBootAutostartSupport } from "../platform/autostart.js";

export async function showConfig(section?: string): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("  No configuration found. Run `ocr setup` first.");
    return;
  }

  console.log();
  console.log("  OpenCode Remote — configuration");
  console.log("  " + "─".repeat(36));

  if (!section || section === "discord") {
    console.log("  Discord");
    console.log(`    Application ID : ${config.discord.applicationId}`);
    console.log(`    Guild ID       : ${config.discord.guildId}`);
    console.log(`    Owner ID       : ${config.discord.ownerId}`);
    console.log(`    Status channel : ${config.discord.statusChannelId || "(not set — health alerts disabled)"}`);
    console.log(`    Token          : ${sanitizeToken(config.discord.token)} (redacted)`);
  }
  if (!section || section === "opencode") {
    console.log("  OpenCode");
    const server = getServerInfo();
    console.log(`    Host/Port      : ${server.host}:${server.port}`);
    console.log(`    Server password: ${config.opencode.serverPassword ? "(set, redacted)" : "(none)"}`);
  }
  if (!section || section === "projects") {
    console.log("  Projects");
    console.log(`    Default dir    : ${config.projects.defaultDir}`);
    for (const p of config.projects.registered) {
      console.log(`    ${p.alias.padEnd(14)} : ${p.path}`);
    }
  }
  if (!section || section === "queue") {
    console.log("  Queue");
    console.log(`    Continue on failure: ${config.queue.continueOnFailure}`);
    console.log(`    Fresh context      : ${config.queue.freshContext}`);
    console.log(`    Stall timeout (s)  : ${(config.queue.stallTimeoutMs ?? 120000) / 1000}`);
    console.log(`    Max job timeout (s): ${(config.queue.maxJobTimeoutMs ?? 0) / 1000}${config.queue.maxJobTimeoutMs ? "" : " (disabled)"}`);
  }
  if (!section || section === "startup") {
    console.log("  Startup");
    console.log(`    Mode             : ${config.startup?.mode ?? "auto"}`);
    const bootEnabled = hasBootAutostartSupport() ? await isBootAutostartEnabled() : false;
    console.log(`    Boot with Windows: ${hasBootAutostartSupport() ? (bootEnabled ? "yes" : "no") : "not supported (non-Windows)"}`);
    console.log(`    Schedule (Task Scheduler): ${config.startup?.mode === "scheduled" ? "yes" : "no"}`);
  }
  if (!section || section === "security") {
    const allow = getAllowlist();
    console.log("  Security");
    for (const a of allow) {
      console.log(`    ${a.isOwner ? "owner " : "user  "} ${a.username.padEnd(16)} ${a.userId}`);
    }
  }
  console.log();
}