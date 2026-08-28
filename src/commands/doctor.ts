import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { loadConfig } from "../storage/index.js";
import { runCommand, getNodeVersion, getPlatform } from "../utils/index.js";
import * as oc from "../opencode/manager.js";
import { isAuthenticated, findGh } from "../github/index.js";
import { checkPort } from "../system/index.js";
import { Icons } from "../discord/ui.js";

interface CheckResult {
  name: string;
  ok: boolean;
  message: string;
}

export const data = new SlashCommandBuilder()
  .setName("doctor")
  .setDescription("Run remote diagnostics on this machine");

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: false });
  const config = loadConfig();

  const checks: CheckResult[] = [];

  checks.push({
    name: "Node.js",
    ok: true,
    message: getNodeVersion(),
  });

  checks.push({
    name: "Platform",
    ok: true,
    message: getPlatform(),
  });

  const gh = await findGh();
  const ghAuth = await isAuthenticated();
  checks.push({
    name: "GitHub CLI",
    ok: gh !== null,
    message: gh
      ? ghAuth
        ? "Authenticated"
        : "installed but not authenticated"
      : "not installed (install: https://cli.github.com)",
  });

  let ocMsg = "not installed";
  let ocOk = false;
  try {
    const bin = await oc.findOpenCodeBinary();
    if (bin) {
      const ver = await runCommand(bin, ["--version"], { timeout: 10000 });
      ocMsg = ver.stdout || ver.stderr || "v?";
      ocOk = true;
    }
  } catch (err) {
    ocMsg = String(err);
  }
  checks.push({
    name: "OpenCode",
    ok: ocOk,
    message: ocMsg,
  });

  const healthy = config ? await oc.isHealthy() : false;
  checks.push({
    name: "OpenCode API",
    ok: healthy,
    message: config ? `${config.opencode.host}:${config.opencode.port}` : "no config",
  });

  checks.push({
    name: "Configuration",
    ok: config !== null,
    message: config ? "found" : "missing — run `ocr setup`",
  });

  if (config) {
    const projectCount = config.projects.registered.length;
    checks.push({
      name: "Projects",
      ok: projectCount > 0,
      message: projectCount > 0 ? `${projectCount} registered` : "none registered",
    });

    const owner = config.discord.ownerId;
    checks.push({
      name: "Owner configured",
      ok: Boolean(owner),
      message: owner ? `id \`${owner.slice(0, 8)}…\`` : "missing",
    });

    const portCheck = await checkPort(config.opencode.port);
    checks[checks.length - 1].message = config
      ? `${config.opencode.host}:${config.opencode.port}${portCheck.inUse ? ` (in use by ${portCheck.processName || portCheck.pid})` : ""}`
      : "—";
  }

  checks.push({
    name: "Git",
    ok: await gitAvailable(),
    message: (await runCommand("git", ["--version"], { timeout: 5000 })).stdout || "not installed",
  });

  const embed = new EmbedBuilder()
    .setColor(checks.every((c) => c.ok) ? Colors.Green : Colors.Yellow)
    .setTitle("Diagnostics")
    .setFooter({ text: "OpenCode Remote" });

  for (const c of checks) {
    embed.addFields({
      name: `${c.ok ? Icons.ok : Icons.fail} ${c.name}`,
      value: `\`${(c.message || "unknown").slice(0, 200)}\``,
      inline: true,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    embed.addFields({
      name: "How to fix",
      value: failed.map((f) => `${f.name}: ${f.message}`).join("\n").slice(0, 1000),
    });
  } else {
    embed.setDescription("All checks passed.");
  }

  await interaction.editReply({ embeds: [embed] });
}

async function gitAvailable(): Promise<boolean> {
  const res = await runCommand("git", ["--version"], { timeout: 5000 });
  return res.code === 0;
}