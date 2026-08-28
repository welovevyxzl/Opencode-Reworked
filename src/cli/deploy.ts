import { loadConfig } from "../storage/index.js";
import { deployCommands } from "../discord/bot.js";

export async function deploySlashCommands(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("  No configuration found. Run `ocr setup` first.");
    return;
  }
  console.log("  Deploying slash commands to Discord...");
  try {
    await deployCommands(config);
    console.log("  ✓ Deployed.");
  } catch (err) {
    console.log(`  ✗ Failed: ${(err as Error).message}`);
  }
}

export async function undeploySlashCommands(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    console.log("  No configuration found. Run `ocr setup` first.");
    return;
  }
  const { REST, Routes } = await import("discord.js");
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  try {
    await rest.put(Routes.applicationGuildCommands(config.discord.applicationId, config.discord.guildId), { body: [] });
    console.log("  ✓ Commands removed from the guild.");
  } catch (err) {
    console.log(`  ✗ Failed: ${(err as Error).message}`);
  }
}