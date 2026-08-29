import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { loadConfig } from "../storage/index.js";
import { runCommand, getNodeVersion, isValidPath } from "../utils/index.js";
import * as oc from "../opencode/manager.js";
import { isAuthenticated, findGh } from "../github/index.js";
import { checkPort } from "../system/index.js";
import { Icons } from "../discord/ui.js";
import * as qs from "../opencode/queue-service.js";
import { checkDatabaseIntegrity, checkDatabaseWritable } from "../storage/index.js";
import { getBuildInfo } from "../utils/build-info.js";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
  fix?: string;
}

export const data = new SlashCommandBuilder()
  .setName("doctor")
  .setDescription("Run remote diagnostics on this machine");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  const config = loadConfig();

  const checks: CheckResult[] = [];

  checks.push({
    name: "Node",
    ok: parseInt(process.versions.node.split(".")[0], 10) >= 22,
    message: getNodeVersion(),
    fix: "Install Node.js 22+ from https://nodejs.org",
  });

  // Build/version info
  const build = getBuildInfo();
  checks.push({
    name: "Build",
    ok: !build.sourceChangedSinceBuild,
    message: `v${build.version} · running from ${build.runningFrom}${build.builtAt ? ` · built ${new Date(build.builtAt).toISOString().slice(0, 16)} UTC` : ""}`,
    fix: build.sourceChangedSinceBuild
      ? "src/ changed since the last build. Run `npm run build` (or `ocr restart`, which rebuilds) so dist/ matches the source."
      : undefined,
  });

  let ocBinary: string | null = null;
  try {
    ocBinary = await oc.findOpenCodeBinary();
  } catch {
    ocBinary = null;
  }
  checks.push({
    name: "OpenCode executable",
    ok: ocBinary !== null,
    message: ocBinary ? ocBinary : "not found",
    fix: ocBinary ? undefined : "Install OpenCode: `npm i -g opencode-ai` (then restart the bot).",
  });

  // OpenCode API with an actionable 401 message.
  const apiOk = await oc.isHealthy().catch(() => false);
  let apiMessage = config ? `${config.opencode.host}:${config.opencode.port}` : "no config";
  let apiFix: string | undefined;
  if (config && !apiOk) {
    const passwordSet = Boolean(config.opencode.serverPassword);
    if (!passwordSet) {
      apiMessage += " — reachable check failed and no server password is configured";
      apiFix = "Re-run `ocr setup` to generate an OPENCODE_SERVER_PASSWORD, or start the OpenCode server with the same password.";
    } else {
      const headers = {
        Authorization: "Basic " + Buffer.from(`opencode:${config.opencode.serverPassword}`).toString("base64"),
      };
      try {
        const res = await fetch(`http://${config.opencode.host}:${config.opencode.port}/config`, {
          headers,
          signal: AbortSignal.timeout(3000),
        });
        if (res.status === 401) {
          apiMessage += " — API returned 401";
          apiFix =
            "The OpenCode API returned 401. The server password used by OpenCode Remote does not match the running OpenCode server. Stop the separately-started `opencode` process (or restart it with the same OPENCODE_SERVER_PASSWORD), then `ocr restart`.";
        } else {
          apiMessage += ` — HTTP ${res.status}`;
          apiFix = "The server on this port is not responding like OpenCode. Check `ocr doctor` output for the port owner.";
        }
      } catch {
        apiMessage += " — not reachable";
        apiFix = "Nothing is listening on the OpenCode port. Enable autoStart in setup or start the server with `ocr start`.";
      }
    }
  }
  checks.push({ name: "OpenCode API", ok: apiOk, message: apiMessage, fix: apiFix });

  // OpenCode auth (models) — distinguishes provider auth from server auth.
  let modelsOk = false;
  let modelsMsg = "no models";
  try {
    const models = await oc.getModels();
    modelsOk = models.length > 0;
    modelsMsg = modelsOk ? `${models.length} models` : "no models — check provider login in OpenCode (opencode auth)";
  } catch (err) {
    modelsMsg = `error: ${String(err).slice(0, 80)}`;
  }
  checks.push({
    name: "OpenCode auth (models)",
    ok: modelsOk,
    message: modelsMsg,
    fix: modelsOk ? undefined : "Run `opencode auth login` in a terminal to connect at least one model provider.",
  });

  // Database checks
  const integrity = checkDatabaseIntegrity();
  checks.push({
    name: "Database integrity",
    ok: integrity.ok,
    message: integrity.message,
    fix: integrity.ok ? undefined : "The SQLite database is corrupt. Restore %USERPROFILE%\\.opencode-remote\\data.db from backup or delete it (queue history is lost).",
  });
  const writable = checkDatabaseWritable();
  checks.push({
    name: "Database writable",
    ok: writable.ok,
    message: writable.message,
    fix: writable.ok ? undefined : "The data directory is read-only or locked by another ocr process. Close other instances and retry.",
  });

  // Queue consistency + stale jobs
  try {
    const stats = qs.getQueueStats();
    const consistent = stats.active <= 1;
    const stale = qs.getStaleJobs(15 * 60_000);
    checks.push({
      name: "Queue",
      ok: consistent && stale.length === 0,
      message: `${stats.queued} queued · ${stats.active} active · ${stats.paused ? "PAUSED" : "active"}${stale.length > 0 ? ` · ${stale.length} stale (heartbeat >15min old)` : ""}`,
      fix: stale.length > 0
        ? `Stale jobs detected (${stale.map((s) => s.id.slice(0, 8)).join(", ")}). The watchdog should fail them automatically; if not, use \`/job cancel <id>\`.`
        : consistent ? undefined : "More than one active job — the queue invariant is violated. Report this state.",
    });
  } catch (err) {
    checks.push({ name: "Queue", ok: false, message: String(err).slice(0, 120) });
  }

  // Git
  const gitRes = await runCommand("git", ["--version"], { timeout: 5000 });
  checks.push({
    name: "Git",
    ok: gitRes.code === 0,
    message: gitRes.code === 0 ? gitRes.stdout : "not installed",
    fix: gitRes.code === 0 ? undefined : "Install Git from https://git-scm.com",
  });

  // GitHub CLI + auth
  const gh = await findGh();
  const ghAuth = gh ? await isAuthenticated() : false;
  checks.push({
    name: "GitHub CLI",
    ok: gh !== null,
    message: gh ? (ghAuth ? "installed & authenticated" : "installed but NOT authenticated") : "not installed",
    fix: gh ? (ghAuth ? undefined : "Run `gh auth login` on the PC.") : "Install gh from https://cli.github.com",
  });

  // Projects
  if (config) {
    const invalid = config.projects.registered.filter((p) => !isValidPath(p.path));
    checks.push({
      name: "Project dirs",
      ok: invalid.length === 0,
      message: invalid.length === 0
        ? `${config.projects.registered.length} registered, all paths exist`
        : `${invalid.length} missing: ${invalid.map((p) => p.alias).join(", ")}`,
      fix: invalid.length === 0 ? undefined : "Re-register missing projects with `/setpath` (paths may have moved).",
    });

    // Status channel
    const statusOk = Boolean(config.discord.statusChannelId);
    checks.push({
      name: "Status channel",
      ok: true,
      message: statusOk ? `configured (${config.discord.statusChannelId})` : "not set — health alerts disabled (set via /config or setup)",
    });

    const portInfo = await checkPort(config.opencode.port);
    checks.push({
      name: "OpenCode port",
      ok: true,
      message: `${config.opencode.port}${portInfo.inUse ? ` (in use by ${portInfo.processName || portInfo.pid})` : " (free)"}`,
    });
  } else {
    checks.push({ name: "Configuration", ok: false, message: "missing — run `ocr setup`", fix: "Run `ocr setup` to create the configuration." });
  }

  const embed = new EmbedBuilder()
    .setColor(checks.every((c) => c.ok) ? Colors.Green : checks.some((c) => !c.ok && c.fix) ? Colors.Yellow : Colors.Orange)
    .setTitle("Diagnostics")
    .setFooter({ text: `OpenCode Remote v${build.version}` });

  for (const c of checks) {
    embed.addFields({
      name: `${c.ok ? Icons.ok : Icons.fail} ${c.name}`,
      value: `\`${c.message.slice(0, 150)}\`${c.fix ? `\n↳ ${c.fix.slice(0, 200)}` : ""}`,
      inline: false,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    embed.setDescription("All checks passed.");
  } else {
    embed.setDescription(`${failed.length} issue(s) found — see the ↳ fix lines above.`);
  }

  await interaction.editReply({ embeds: [embed] });
}
