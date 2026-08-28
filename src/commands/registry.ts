import type {
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";

export interface CommandDefinition {
  data:
    | SlashCommandBuilder
    | SlashCommandOptionsOnlyBuilder
    | SlashCommandSubcommandsOnlyBuilder;
  execute: (interaction: import("discord.js").ChatInputCommandInteraction) => Promise<void>;
  autocomplete?: (interaction: import("discord.js").AutocompleteInteraction) => Promise<void>;
}

const commands = new Map<string, CommandDefinition>();

export function registerCommand(def: CommandDefinition): void {
  commands.set(def.data.name, def);
}

export function buildCommands(): ReturnType<CommandDefinition["data"]["toJSON"]>[] {
  return [...commands.values()].map((c) => c.data.toJSON());
}

export function getCommand(name: string): CommandDefinition | undefined {
  return commands.get(name);
}

export function getAllCommands(): CommandDefinition[] {
  return [...commands.values()];
}