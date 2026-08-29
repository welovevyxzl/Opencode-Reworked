import { getCommand, type CommandDefinition, buildCommands } from "./registry.js";
import { checkAuth } from "../security/auth.js";
import { logWarn } from "../utils/logger.js";
import { registerAllCommands } from "./setup.js";

export { buildCommands };

const handlers: Array<() => void> = [];

export function registerCommandHandlers(): void {
  if (handlers.length > 0) return;
  registerAllCommands();
}

export async function handleInteraction(
  interaction: import("discord.js").Interaction
): Promise<void> {
  const def = getCommandDef(interaction);
  if (!def) return;
  if (def.autocomplete && interaction.isAutocomplete()) {
    await def.autocomplete(interaction);
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  const auth = checkAuth(userId);

  if (!auth.authorized) {
    await interaction.reply({ content: "You are not authorized to control this machine.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "allow") {
    if (!auth.owner) {
      await interaction.reply({ content: "Only the owner can manage the authorization allowlist.", ephemeral: true });
      return;
    }
  }

  if (interaction.commandName === "remote") {
    if (!auth.owner) {
      await interaction.reply({ content: "Only the owner can view remote access info.", ephemeral: true });
      return;
    }
  }

  if (interaction.commandName === "pc") {
    if (!auth.owner) {
      await interaction.reply({ content: "Only the owner can control the PC.", ephemeral: true });
      return;
    }
  }

  try {
    await def.execute(interaction);
  } catch (err) {
    logWarn(`Command ${interaction.commandName} error: ${String(err)}`, "commands");
    const reply = {
      content: `\u00d7 ${err instanceof Error ? err.message : String(err)}`,
      ephemeral: true,
    };
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply).catch(() => undefined);
      } else {
        await interaction.reply(reply).catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }
}

function getCommandDef(interaction: import("discord.js").Interaction): CommandDefinition | undefined {
  if (!interaction.isChatInputCommand()) return undefined;
  return getCommand(interaction.commandName);
}