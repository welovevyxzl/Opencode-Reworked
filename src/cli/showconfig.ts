import { loadConfig, getAllowlist } from "../storage/index.js";
import { sanitizeToken } from "../security/auth.js";
import { getServerInfo } from "../opencode/manager.js";

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
    console.log(`    Token          : ${sanitizeToken(config.discord.token)} (redacted)`);
  }
  if (!section || section === "opencode") {
    console.log("  OpenCode");
    const server = getServerInfo();
    console.log(`    Host/Port      : ${server.host}:${server.port}`);
    console.log(`    AutoStart      : ${config.opencode.autoStart ? "yes" : "no"}`);
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