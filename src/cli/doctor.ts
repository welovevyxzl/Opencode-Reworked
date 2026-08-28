import { initDatabase, loadConfig, closeDatabase } from "../storage/index.js";
import { initLogger } from "../utils/logger.js";
import { findOpenCodeBinary, isHealthy, configure } from "../opencode/manager.js";
import { isAuthenticated, findGh } from "../github/index.js";
import { runCommand, getNodeVersion, isValidPath } from "../utils/index.js";
import { checkPort } from "../system/index.js";

interface Check {
  name: string;
  status: "ok" | "error" | "warning";
  message: string;
}

const WIDTH = 16;

export async function runDoctor(): Promise<void> {
  initLogger("INFO");
  initDatabase();
  const config = loadConfig();

  const checks: Check[] = [];

  checks.push({ name: "Node", status: "ok", message: getNodeVersion() });

  if (config) {
    try {
      const ok = await canLogin(config.discord.token)
      checks.push({ name: "Discord", status: ok ? "ok" : "error", message: ok ? "Credentials OK" : "Login failed" });
    } catch (err) {
      checks.push({ name: "Discord", status: "error", message: String(err) });
    }
  } else {
    checks.push({ name: "Discord", status: "warning", message: "no config" });
  }

  let ocBin = null;
  try {
    ocBin = await findOpenCodeBinary();
    checks.push({ name: "OpenCode", status: ocBin ? "ok" : "error", message: ocBin ? `${await openCodeVersion(ocBin)} (${short(ocBin)})` : "not installed — try: npm i -g opencode-ai" });
  } catch (err) {
    checks.push({ name: "OpenCode", status: "error", message: String(err) });
  }

  if (config) {
    configure(config);
    const healthy = await isHealthy();
    checks.push({
      name: "OpenCode API",
      status: healthy ? "ok" : "warning",
      message: `${config.opencode.host}:${config.opencode.port}${healthy ? "" : " — not reachable"}`,
    });
  } else {
    checks.push({ name: "OpenCode API", status: "warning", message: "no config" });
  }

  const gitRes = await runCommand("git", ["--version"], { timeout: 5000 });
  checks.push({
    name: "Git",
    status: gitRes.code === 0 ? "ok" : "error",
    message: gitRes.code === 0 ? gitRes.stdout : "not installed",
  });

  const ghBin = await findGh();
  const ghAuth = ghBin ? await isAuthenticated() : false;
  checks.push({
    name: "GitHub CLI",
    status: ghBin ? (ghAuth ? "ok" : "warning") : "error",
    message: ghBin ? (ghAuth ? "Authenticated" : "installed but not authenticated — run `gh auth login`") : "not installed — install from https://cli.github.com",
  });

  if (config) {
    const registered = config.projects.registered;
    const invalid = registered.filter((p) => !isValidPath(p.path));
    checks.push({
      name: "Projects",
      status: registered.length > 0 && invalid.length === 0 ? "ok" : invalid.length > 0 ? "warning" : "warning",
      message: invalid.length > 0 ? `${registered.length} registered, ${invalid.length} paths missing` : `${registered.length} registered`,
    });

    for (const p of registered) {
      if (!isValidPath(p.path)) {
        checks.push({ name: `   ${p.alias}`, status: "warning", message: p.path });
      }
    }

    checks.push({ name: "Owner", status: config.discord.ownerId ? "ok" : "error", message: config.discord.ownerId ? `configured (${redactId(config.discord.ownerId)})` : "missing" });

    const portInfo = await checkPort(config.opencode.port);
    checks.push({
      name: "OpenCode port",
      status: "ok",
      message: `${config.opencode.port}${portInfo.inUse ? " (in use)" : " (free)"}`,
    });

    checks.push({ name: "Configuration", status: "ok", message: "found" });
  } else {
    checks.push({ name: "Configuration", status: "error", message: "missing — run `ocr setup`" });
    checks.push({ name: "OpenCode port", status: "warning", message: "no config" });
  }

  closeDatabase();

  console.log();
  console.log("  OpenCode Remote — doctor");
  console.log("  " + "─".repeat(36));
  for (const c of checks) {
    const icon = c.status === "ok" ? "✓" : c.status === "warning" ? "◌" : "×";
    console.log(`  ${c.name.padEnd(WIDTH - 2)} ${icon} ${c.message}`);
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