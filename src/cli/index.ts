#!/usr/bin/env node
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runSetup } from "../setup/wizard.js";
import { startBot, stopBot, restartBot } from "./start.js";
import { printStatus } from "./status.js";
import { runDoctor } from "./doctor.js";
import { deploySlashCommands, undeploySlashCommands } from "./deploy.js";
import { showConfig } from "./showconfig.js";
import { updateApp } from "./update.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let pkg: { version?: string } = {};
try {
  pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));
} catch {
  try {
    pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
  } catch {
    // ignore
  }
}
export const VERSION = pkg.version || "1.0.0";

async function main(): Promise<void> {
  const arg = process.argv[2];
  const sub = process.argv[3];
  switch (arg) {
    case "setup":
      await runSetup();
      break;
    case "start":
      await startBot();
      break;
    case undefined:
      await startBot();
      break;
    case "stop":
      await stopBot();
      break;
    case "restart":
      await restartBot();
      break;
    case "status":
      await printStatus();
      break;
    case "doctor":
      await runDoctor();
      break;
    case "deploy":
      await deploySlashCommands();
      break;
    case "undeploy":
      await undeploySlashCommands();
      break;
    case "config":
      await showConfig(sub);
      break;
    case "update":
      await updateApp();
      break;
    case "--version":
    case "-v":
      console.log(VERSION);
      break;
    case "--help":
    case "-h":
      console.log(banner());
      printUsage();
      break;
    default:
      console.log(`Unknown command: ${arg}`);
      printUsage();
      process.exitCode = 1;
  }
}

function banner(): string {
  return [
    "",
    "  OpenCode Remote",
    "  A reliable Discord remote-control for OpenCode",
    "",
  ].join("\n");
}

function printUsage(): void {
  console.log(`  Usage: ocr <command>

  Commands:
    setup       Interactive setup wizard
    start       Start the bot (default when no command given)
    stop        Stop the running bot
    restart     Restart the bot
    status      Show bot status
    doctor      Run diagnostics
    deploy      Deploy slash commands to Discord
    undeploy    Remove slash commands from Discord
    config      Show current configuration (values redacted)
    update      Check for updates
    help        Show this help`);
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});