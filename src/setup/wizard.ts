import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { existsSync } from "fs";
import { loadConfig, saveConfig, ensureDataDir, addToAllowlist, initDatabase } from "../storage/index.js";
import { generateServerPassword } from "../security/auth.js";
import { findOpenCodeBinary } from "../opencode/manager.js";
import { isAuthenticated } from "../github/index.js";
import { deployCommands } from "../discord/bot.js";
import { logInfo } from "../utils/logger.js";
import { validateDiscordToken, validateDiscord } from "./validate.js";

let rl: ReturnType<typeof createInterface> | null = null;

export async function promptText(question: string, opts: { default?: string; required?: boolean; validator?: (v: string) => string | null } = {}): Promise<string | null> {
  const suffix = opts.default !== undefined ? ` (${opts.default})` : "";
  for (;;) {
    const answer = (await rl!.question(`  ${question}${suffix}: `)).trim();
    const val = answer || opts.default || "";
    if (!val && opts.required) {
      console.log("  Required.");
      continue;
    }
    if (!val) return null;
    if (opts.validator) {
      const err = opts.validator(val);
      if (err) {
        console.log(`  ${err}`);
        continue;
      }
    }
    return val;
  }
}

export async function promptConfirm(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " (Y/n)" : " (y/N)";
  for (;;) {
    const answer = (await rl!.question(`  ${question}${suffix}: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    console.log("  Please answer y or n.");
  }
}

export async function runSetup(): Promise<void> {
  ensureDataDir();
  rl = createInterface({ input: stdin, output: stdout });
  console.log();
  console.log("  OpenCode Remote — setup");
  console.log("  " + "─".repeat(44));

  const existing = loadConfig();
  if (existing) {
    console.log("  Existing configuration detected. It will be overwritten.");
  }

  console.log();
  console.log("  Discord bot credentials (create a bot at https://discord.com/developers).");
  console.log();

  const token = await promptText("Discord bot token", {
    required: true,
    validator: validateDiscordToken,
  });
  if (!token) {
    console.log("  Setup aborted.");
    cleanup();
    process.exit(1);
  }

  const appId = await promptText("Discord Application ID", {
    required: true,
    validator: (v) => (/^\d{15,25}$/.test(v) ? null : "Must be a numeric application ID."),
  });
  if (!appId) {
    console.log("  Setup aborted.");
    cleanup();
    process.exit(1);
  }

  const guildId = await promptText("Discord Server (Guild) ID", {
    required: true,
    validator: (v) => (/^\d{15,25}$/.test(v) ? null : "Must be a numeric guild ID."),
  });
  if (!guildId) {
    console.log("  Setup aborted.");
    cleanup();
    process.exit(1);
  }

  const ownerId = await promptText("Your Discord User ID (owner)", {
    required: true,
    validator: (v) => (/^\d{15,25}$/.test(v) ? null : "Must be a numeric Discord user ID."),
  });
  if (!ownerId) {
    console.log("  Setup aborted.");
    cleanup();
    process.exit(1);
  }

  console.log();
  console.log("  Projects");
  const defaultDir = await promptText("Default projects directory", {
    required: false,
    default: process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Projects` : process.cwd(),
    validator: (v) => (existsSync(v.trim()) ? null : `Directory does not exist: ${v}`),
  });
  if (!defaultDir) {
    console.log("  Setup aborted.");
    cleanup();
    process.exit(1);
  }

  const port = await promptText("OpenCode port", {
    default: "4096",
    required: true,
    validator: (v) => {
      const n = parseInt(v, 10);
      return Number.isInteger(n) && n >= 1024 && n <= 65535 ? null : "Must be a valid port 1024-65535.";
    },
  });
  const autoStart = await promptConfirm("Start OpenCode automatically with the bot", true);
  const ghEnabled = await promptConfirm("Enable GitHub integration", true);
  const openaiKey = await promptText("OpenAI API key for voice transcription (optional)", { required: false });
  const allowVoice = Boolean(openaiKey);

  let ghSetting = ghEnabled;
  if (ghEnabled) {
    const ok = await isAuthenticated();
    if (!ok) {
      console.log();
      console.log("  ⚠ gh is not authenticated. Run `gh auth login` first, or `/github` will not work.");
      const stillEnable = await promptConfirm("Continue with GitHub enabled anyway", false);
      if (!stillEnable) {
        ghSetting = false;
      }
    }
  }

  console.log();
  console.log("  Validating OpenCode...");
  let ocBinary = null;
  try {
    ocBinary = await findOpenCodeBinary();
  } catch {
    ocBinary = null;
  }
  if (ocBinary) {
    console.log(`    ✓ OpenCode found: ${ocBinary}`);
  } else {
    console.log("    ! OpenCode not detected. Install it: npm i -g opencode-ai");
  }

  console.log("  Validating Discord credentials...");
  const disc = await validateDiscord(token, appId, guildId);
  if (!disc.botOk) {
    console.log(`    ✗ Discord bot login failed: ${disc.error}`);
    cleanup();
    process.exit(1);
  }
  console.log(`    ✓ Bot login ok (${disc.botName || "unknown"})`);
  if (!disc.guildOk) {
    console.log(`    ✗ Bot cannot access guild ${guildId}: ${disc.guildError}`);
    cleanup();
    process.exit(1);
  }
  console.log("    ✓ Guild access ok");

  const config = {
    discord: { token, applicationId: appId, guildId, ownerId },
    opencode: {
      port: parseInt(port as string, 10),
      host: "127.0.0.1",
      serverPassword: generateServerPassword(),
      autoStart,
    },
    projects: { defaultDir, registered: [] },
    github: { enabled: ghSetting },
    voice: { enabled: allowVoice, openaiApiKey: openaiKey || undefined },
    queue: { continueOnFailure: true, freshContext: false },
  };

  saveConfig(config);
  initDatabase();
  addToAllowlist({
    userId: ownerId,
    username: "owner",
    addedAt: Date.now(),
    addedBy: "setup",
    isOwner: true,
  });
  logInfo("Configuration saved", "setup");

  console.log();
  console.log("  Deploying slash commands...");
  try {
    await deployCommands(config);
    console.log("    ✓ Slash commands deployed");
  } catch (err) {
    console.log(`    ✗ Failed to deploy slash commands: ${(err as Error).message}`);
  }

  console.log();
  console.log("  ─".repeat(44));
  console.log("  ✓ Setup complete.");
  console.log(`    Owner: ${ownerId} (pre-authorized)`);
  console.log(`    OpenCode: 127.0.0.1:${port} (autoStart: ${autoStart ? "yes" : "no"})`);
  console.log(`    Projects dir: ${defaultDir}`);
  console.log(`    GitHub: ${ghSetting ? "enabled" : "disabled"}`);
  console.log(`    Voice: ${allowVoice ? "enabled" : "disabled"}`);
  console.log(`    Secrets stored locally in %USERPROFILE%\\.opencode-remote (never printed)`);
  console.log();
  console.log("  Next: run `ocr start` to launch the bot.");
  cleanup();
}

export function cleanup(): void {
  if (rl) rl.close();
  rl = null;
}