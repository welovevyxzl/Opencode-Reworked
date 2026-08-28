import {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  Routes,
  REST,
  type Interaction,
  type Message,
  type ThreadChannel,
  type TextChannel,
  type BaseInteraction,
} from "discord.js";
import { loadConfig, getAllowlist } from "../storage/index.js";
import { logInfo, logWarn, logError } from "../utils/logger.js";
import { startServer, isHealthy } from "../opencode/manager.js";
import { registerCommandHandlers, handleInteraction } from "../commands/index.js";
import { registerMessageHandlers, handleMessage } from "../commands/passthrough.js";
import { registerComponentHandlers, handleComponent } from "../commands/components.js";
import { ensureOwnerInAllowlist } from "../security/auth.js";

let client: Client | null = null;
let startedAt = 0;

export function isConnected(): boolean {
  return client?.isReady() ?? false;
}

export function getClient(): Client | null {
  return client;
}

export async function connect(config: ReturnType<typeof loadConfig>): Promise<{ ok: boolean; error?: string }> {
  if (!config) return { ok: false, error: "No configuration found. Run ocr setup first." };

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  registerCommandHandlers();
  registerMessageHandlers();
  registerComponentHandlers();

  client.on("clientReady", async () => {
    startedAt = Date.now();
    const user = client?.user;
    logInfo(`Discord connected as ${user?.tag}`, "discord");
    try {
      client?.user?.setActivity(`/help | ${config.discord.guildId}`, { type: ActivityType.Playing });
    } catch {
      // non-fatal
    }
    ensureOwnerInAllowlist();
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        await handleComponent(interaction as unknown as BaseInteraction);
      } else {
        await handleInteraction(interaction);
      }
    } catch (err) {
      logError(`Interaction handler crashed: ${String(err)}`, "discord");
      try {
        if (interaction.isRepliable() && !interaction.replied) {
          await interaction.reply({
            content: "Something went wrong handling that. The error was logged.",
            ephemeral: true,
          }).catch(() => undefined);
        }
      } catch {
        // ignore secondary failure
      }
    }
  });

  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;
    try {
      await handleMessage(message);
    } catch (err) {
      logError(`Message handler crashed: ${String(err)}`, "discord");
    }
  });

  try {
    await client.login(config.discord.token);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`Discord login failed: ${message}`, "discord");
    client = null;
    return { ok: false, error: message };
  }
}

export async function disconnect(): Promise<void> {
  if (client) {
    try {
      client.destroy();
    } catch {
      // ignore
    }
    client = null;
  }
}

export async function deployCommands(config: NonNullable<ReturnType<typeof loadConfig>>): Promise<void> {
  registerCommandHandlers();
  const rest = new REST({ version: "10" }).setToken(config.discord.token);
  const { buildCommands } = await import("../commands/index.js");
  const commands = buildCommands();
  try {
    await rest.put(Routes.applicationGuildCommands(
      config.discord.applicationId,
      config.discord.guildId
    ), { body: commands });
    logInfo(`Deployed ${commands.length} guild commands`, "discord");
  } catch (err) {
    logError(`Failed to deploy commands: ${String(err)}`, "discord");
    throw err;
  }
}

export function getBotStatus(): { connected: boolean; uptime: number; tag?: string } {
  return {
    connected: isConnected(),
    uptime: client?.isReady() ? Date.now() - startedAt : 0,
    tag: client?.user?.tag,
  };
}

export async function startOpenCodeAndDiscord(): Promise<{
  ok: boolean;
  discord: boolean;
  opencode: boolean;
  messages: string[];
}> {
  const config = loadConfig();
  if (!config) {
    return { ok: false, discord: false, opencode: false, messages: ["No configuration found. Run ocr setup first."] };
  }

  const messages: string[] = [];
  let ocOk = false;
  if (config.opencode.autoStart) {
    const result = await startServer();
    ocOk = result.ok;
    messages.push(result.message);
  } else {
    ocOk = await isHealthy();
    messages.push(ocOk ? "OpenCode already running" : "OpenCode not started (autoStart disabled)");
  }

  const dOk = await connect(config);
  messages.push(dOk.ok ? "Discord connected" : `Discord failed: ${dOk.error}`);

  return { ok: dOk.ok && ocOk, discord: dOk.ok, opencode: ocOk, messages };
}

export async function createThread(
  channel: TextChannel,
  name: string,
  message?: string
): Promise<ThreadChannel | null> {
  try {
    const thread = await channel.threads.create({
      name: name.slice(0, 100),
      autoArchiveDuration: 1440,
    });
    if (message) await thread.send(message);
    return thread;
  } catch (err) {
    logWarn(`Failed to create thread: ${String(err)}`, "discord");
    return null;
  }
}

export async function sendThreadStatus(
  channel: { send: (arg: unknown) => Promise<Message> },
  content: unknown
): Promise<Message | null> {
  try {
    return await (channel as TextChannel).send(content as never);
  } catch (err) {
    logWarn(`Failed to send status to thread: ${String(err)}`, "discord");
    return null;
  }
}

export function getAuthorizedUserCount(): number {
  return getAllowlist().length;
}