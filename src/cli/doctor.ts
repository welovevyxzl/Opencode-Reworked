import { initDatabase, loadConfig, closeDatabase, checkDatabaseIntegrity, checkDatabaseWritable } from "../storage/index.js";
import { initLogger } from "../utils/logger.js";
import { findOpenCodeBinary, isHealthy, configure } from "../opencode/manager.js";
import { isAuthenticated, findGh } from "../github/index.js";
import { runCommand, getNodeVersion, isValidPath } from "../utils/index.js";
import { checkPort } from "../system/index.js";
import { formatBuildSummary, getBuildInfo } from "../utils/build-info.js";

interface Check {
  name: string;
  status: "ok" | "error" | "warning";
  message: string;
  fix?: string;
}

const WIDTH = 20;

export async function runDoctor(): Promise<void> {
  initLogger("INFO");
  initDatabase();
  const config = loadConfig();

  const checks: Check[] = [];

  checks.push({ name: "Node", status: getNodeMajor() >= 22 ? "ok" : "warning", message: getNodeVersion() });
  checks.push({ name: "Build", status: getBuildInfo().sourceChangedSinceBuild ? "warning" : "ok", message: formatBuildSummary() });

  if (config) {
    try {
      const ok = await canLogin(config.discord.token);
      checks.push({ name: "Discord", status: ok ? "ok" : "error", message: ok ? "Credentials OK" : "Login failed", fix: ok ? undefined : "The bot token is invalid or expired. Re-run `ocr setup`." });
    } catch (err) {
      checks.push({ name: "Discord", status: "error", message: String(err) });
    }
  } else {
    checks.push({ name: "Discord", status: "warning", message: "no config" });
  }

  let ocBin: string | null = null;
  try {
    ocBin = await findOpenCodeBinary();
    checks.push({ name: "OpenCode", status: ocBin ? "ok" : "error", message: ocBin ? `${await openCodeVersion(ocBin)} (${short(ocBin)})` : "not installed — try: npm i -g opencode-ai" });
  } catch (err) {
    checks.push({ name: "OpenCode", status: "error", message: String(err) });
  }

  if (config) {
    configure(config);
    const healthy = await isHealthy();
    let apiMsg = `${config.opencode.host}:${config.opencode.port}${healthy ? "" : " — not reachable"}`;
    let apiFix: string | undefined;
    if (!healthy) {
      try {
        const headers = { Authorization: "Basic " + Buffer.from(`opencode:${config.opencode.serverPassword}`).toString("base64") };
        const res = await fetch(`http://${config.opencode.host}:${config.opencode.port}/config`, { headers, signal: AbortSignal.timeout(3000) });
        if (res.status === 401) {
          apiMsg += " — 401";
          apiFix = "The OpenCode API returned 401: the server password does not match the running OpenCode server. Restart OpenCode with the same OPENCODE_SERVER_PASSWORD (or stop the foreign process).";
        } else {
          apiFix = "Something is listening but not responding like OpenCode. Check the port owner below.";
        }
      } catch {
        apiFix = "Nothing is listening on the port. Ensure autoStart is enabled or run `ocr start` with OpenCode installed.";
      }
    }
    checks.push({ name: "OpenCode API", status: healthy ? "ok" : "warning", message: apiMsg, fix: apiFix });
  } else {
    checks.push({ name: "OpenCode API", status: "warning", message: "no config" });
  }

  const gitRes = await runCommand("git", ["--version"], { timeout: 5000 });
  checks.push({
    name: "Git",
    status: gitRes.code === 0 ? "ok" : "error",
    message: gitRes.code === 0 ? gitRes.stdout : "not installed",
    fix: gitRes.code === 0 ? undefined : "Install Git from https://git-scm.com",
  });

  const ghBin = await findGh();
  const ghAuth = ghBin ? await isAuthenticated() : false;
  checks.push({
    name: "GitHub CLI",
    status: ghBin ? (ghAuth ? "ok" : "warning") : "error",
    message: ghBin ? (ghAuth ? "Authenticated" : "installed but not authenticated — run `gh auth login`") : "not installed — install from https://cli.github.com",
  });

  const integrity = checkDatabaseIntegrity();
  checks.push({ name: "Database integrity", status: integrity.ok ? "ok" : "error", message: integrity.message });
  const writable = checkDatabaseWritable();
  checks.push({ name: "Database writable", status: writable.ok ? "ok" : "error", message: writable.message, fix: writable.ok ? undefined : "Close other ocr instances or fix permissions on %USERPROFILE%\\.opencode-remote." });

  if (config) {
    const registered = config.projects.registered;
    const invalid = registered.filter((p) => !isValidPath(p.path));
    checks.push({
      name: "Projects",
      status: registered.length > 0 && invalid.length === 0 ? "ok" : "warning",
      message: invalid.length > 0 ? `${registered.length} registered, ${invalid.length} paths missing` : `${registered.length} registered`,
      fix: invalid.length > 0 ? `Re-register moved projects with /setpath: ${invalid.map((p) => p.alias).join(", ")}` : registered.length === 0 ? "Register at least one project with /setpath." : undefined,
    });

    checks.push({ name: "Owner", status: config.discord.ownerId ? "ok" : "error", message: config.discord.ownerId ? `configured (${redactId(config.discord.ownerId)})` : "missing" });

    checks.push({ name: "Status channel", status: "ok", message: config.discord.statusChannelId ? `configured (${config.discord.statusChannelId})` : "not set (health alerts disabled)" });

    const portInfo = await checkPort(config.opencode.port);
    checks.push({
      name: "OpenCode port",
      status: "ok",
      message: `${config.opencode.port}${portInfo.inUse ? " (in use)" : " (free)"}`,
    });

    checks.push({ name: "Configuration", status: "ok", message: "found" });
  } else {
    checks.push({ name: "Configuration", status: "error", message: "missing — run `ocr setup`", fix: "Run `ocr setup` to create the configuration." });
    checks.push({ name: "OpenCode port", status: "warning", message: "no config" });
  }

  closeDatabase();

  console.log();
  console.log(`  OpenCode Remote — doctor  ${formatBuildSummary()}`);
  console.log("  " + "─".repeat(36));
  for (const c of checks) {
    const icon = c.status === "ok" ? "✓" : c.status === "warning" ? "◌" : "×";
    console.log(`  ${c.name.padEnd(WIDTH - 2)} ${icon} ${c.message}`);
    if (c.fix) console.log(`  ${" ".repeat(WIDTH)} ↳ ${c.fix}`);
  }
  console.log("  " + "─".repeat(36));

  const errors = checks.filter((c) => c.status === "error");
  if (errors.length === 0) {
    console.log("  All checks passed.");
  } else {
    console.log(`  ${errors.length} issue${errors.length > 1 ? "s" : ""} found. Fixes above.`);
  }
  console.log();
}

function getNodeMajor(): number {
  return parseInt(process.versions.node.split(".")[0], 10);
}

async function canLogin(token: string): Promise<boolean> {
  try {
    const { Client, GatewayIntentBits } = await import("discord.js");
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(token);
    const ok = client.isReady();
    client.destroy();
    return ok;
  } catch {
    return false;
  }
}

async function openCodeVersion(bin: string): Promise<string> {
  const res = await runCommand(bin, ["--version"], { timeout: 10000 });
  return (res.stdout || res.stderr || "v?").split("\n")[0];
}

function short(p: string): string {
  if (p.length <= 30) return p;
  return "…" + p.slice(-27);
}

function redactId(id: string): string {
  return id.slice(0, 6) + "…" + id.slice(-4);
}
