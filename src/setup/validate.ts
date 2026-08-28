import { Client, GatewayIntentBits } from "discord.js";

export function validateDiscordToken(token: string): string | null {
  const t = token.trim();
  if (t.length < 20) return "Token is too short.";
  if (!/^[A-Za-z0-9._-]+$/.test(t)) return "Token contains invalid characters.";
  return null;
}

export interface DiscordValidationResult {
  botOk: boolean;
  botName?: string;
  error?: string;
  guildOk: boolean;
  guildError?: string;
}

export async function validateDiscord(
  token: string,
  applicationId: string,
  guildId: string
): Promise<DiscordValidationResult> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  let botOk = false;
  let guildOk = false;
  let botName: string | undefined;
  let errorMsg = "";

  try {
    await client.login(token);
    botOk = await waitForReady(client, 20000);
    botName = client.user?.tag;

    if (botOk) {
      try {
        const guild = await client.guilds.fetch(guildId);
        guildOk = guild !== null;
      } catch (err) {
        const e = err as Error;
        errorMsg = e.message.includes("10004") ? "Unknown guild (is the bot invited?)" : e.message;
        guildOk = false;
      }
    }
  } catch (err) {
    const e = err as Error;
    if (e.message.includes("TOKEN_INVALID") || e.message.includes("401")) {
      errorMsg = "Invalid bot token.";
    } else {
      errorMsg = e.message;
    }
    botOk = false;
  } finally {
    client.destroy();
  }

  if (!botOk && !errorMsg) errorMsg = "login failed (client did not reach ready state)";

  return { botOk, guildOk, botName, error: errorMsg, guildError: guildOk ? undefined : errorMsg || "could not access guild" };
}

async function waitForReady(client: Client, timeoutMs: number): Promise<boolean> {
  if (client.isReady()) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    client.once("clientReady", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}