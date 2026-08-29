import { ChannelType, type GuildTextBasedChannel, type SendableChannels, type ThreadChannel } from "discord.js";
import { getClient } from "./bot.js";
import { logWarn, logDebug } from "../utils/logger.js";

/**
 * Resolve a Discord channel by ID: cache → fetch → validate sendable.
 * A valid but uncached thread must never silently lose live output.
 */
export async function resolveDiscordChannel(channelId: string): Promise<SendableChannels | null> {
  const client = getClient();
  if (!client) {
    logDebug("No Discord client; cannot resolve channel", "discord", { channelId });
    return null;
  }

  let channel = client.channels.cache.get(channelId) ?? null;

  if (!channel || channel.partial) {
    try {
      channel = (await client.channels.fetch(channelId, { force: true })) ?? null;
    } catch (err) {
      logWarn(`Failed to fetch channel ${channelId}: ${String(err)}`, "discord");
      return null;
    }
  }

  if (!channel) return null;

  if (!("send" in channel) || typeof (channel as { send?: unknown }).send !== "function") {
    logWarn(`Channel ${channelId} is not sendable (type ${ChannelType[channel.type] ?? channel.type})`, "discord");
    return null;
  }

  // Threads can be archived — try to revive so live output keeps flowing.
  if ("archived" in channel && (channel as ThreadChannel).archived) {
    try {
      await (channel as ThreadChannel).setArchived(false, "OpenCode Remote live output");
    } catch (err) {
      logWarn(`Could not unarchive thread ${channelId}: ${String(err)}`, "discord");
    }
  }

  return channel as SendableChannels;
}

/** Fetch a message in a channel, tolerating cache misses and archived threads. */
export async function resolveDiscordMessage(
  channelId: string,
  messageId: string
): Promise<{ channel: SendableChannels; message: import("discord.js").Message } | null> {
  const channel = await resolveDiscordChannel(channelId);
  if (!channel) return null;
  try {
    const message = await (channel as GuildTextBasedChannel).messages.fetch(messageId);
    return { channel, message };
  } catch {
    return null;
  }
}

/** Safe send helper: resolves the channel and swallows Discord errors (logged). */
export async function safeSend(
  channelId: string,
  payload: Parameters<SendableChannels["send"]>[0]
): Promise<import("discord.js").Message | null> {
  const channel = await resolveDiscordChannel(channelId);
  if (!channel) return null;
  try {
    return await channel.send(payload);
  } catch (err) {
    logWarn(`Send to ${channelId} failed: ${String(err)}`, "discord");
    return null;
  }
}
