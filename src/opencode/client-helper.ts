import { getClient } from "../discord/bot.js";
import type { Client } from "discord.js";

export function getClientSafe(): Client | null {
  try {
    return getClient();
  } catch {
    return null;
  }
}
