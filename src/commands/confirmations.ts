import { randomBytes } from "crypto";
import { BaseInteraction, ButtonBuilder, ButtonStyle, ActionRowBuilder } from "discord.js";
import { checkAuth } from "../security/auth.js";
import { logInfo, logWarn } from "../utils/logger.js";
import {
  savePendingAction,
  getPendingAction,
  deletePendingAction,
  cleanupExpiredPendingActions,
} from "../storage/index.js";
import { sleep } from "../system/index.js";

const CONFIRM_TIMEOUT = 30000;

export const CONFIRM_TIMEOUT_MS = CONFIRM_TIMEOUT;

/** Pending action types and their Discord custom id prefixes. */
type ConfirmAction = "sleep" | "restart" | "shutdown";

export function parseConfirmationId(
  customId: string
): { action: string; choice: string; key: string } | null {
  const match = customId.match(/^confirm_(sleep|restart|shutdown)_(yes|no)_(.+)$/);
  if (!match) return null;
  return { action: match[1], choice: match[2], key: match[3] };
}

/**
 * Register a durable confirmation. The action id is cryptographically random
 * and the full record (type, requester, expiry) persists in SQLite, so a
 * restart never leaves broken buttons and ids cannot be guessed or replayed.
 */
export async function registerConfirmation(
  interaction: BaseInteraction,
  action: ConfirmAction
): Promise<void> {
  const key = randomBytes(16).toString("hex");
  savePendingAction({
    id: key,
    type: `pc:${action}`,
    channelId: interaction.channelId ?? undefined,
    requesterId: interaction.user.id,
    createdAt: Date.now(),
    expiresAt: Date.now() + CONFIRM_TIMEOUT,
  });

  const confirm = new ButtonBuilder()
    .setCustomId(`confirm_${action}_yes_${key}`)
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("✅");
  const cancel = new ButtonBuilder()
    .setCustomId(`confirm_${action}_no_${key}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("❌");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);

  try {
    if (interaction.isRepliable()) {
      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ content: `⚠️ This will **${action.toUpperCase()}** the PC. Confirm within 30s.`, components: [row] });
      } else {
        await interaction.reply({
          content: `⚠️ This will **${action.toUpperCase()}** the PC. Confirm within 30s.`,
          components: [row],
          ephemeral: false,
        });
      }
    }
  } catch (err) {
    logInfo(`Confirmation reply failed: ${err}`, "confirmations");
  }
}

/**
 * Execute a confirmation button press. Authorization is independently
 * verified here (owner + original requester) — never trusted from the custom
 * id. Single-use: the pending action is deleted before executing.
 */
export async function handleConfirmAction(interaction: BaseInteraction): Promise<void> {
  if (!interaction.isButton()) return;

  const parsed = parseConfirmationId(interaction.customId);
  if (!parsed) return;
  const { action, choice, key } = parsed;

  const pending = getPendingAction(key);

  if (!pending) {
    await interaction.reply({ content: "Confirmation expired, already used, or from a previous bot run. Run the command again.", ephemeral: true }).catch(() => undefined);
    return;
  }

  // Single-use: delete first so concurrent clicks cannot double-execute.
  deletePendingAction(key);

  if (Date.now() > pending.expiresAt) {
    await interaction.reply({ content: "Confirmation expired after 30 seconds. Run the command again.", ephemeral: true }).catch(() => undefined);
    return;
  }

  // Independent authorization check at the execution layer.
  const auth = checkAuth(interaction.user.id);
  if (!auth.authorized || !auth.owner) {
    await interaction.reply({ content: "Only the owner can control the PC.", ephemeral: true }).catch(() => undefined);
    return;
  }
  // Only the requester may confirm their own destructive action.
  if (pending.requesterId !== interaction.user.id) {
    await interaction.reply({ content: "Only the user who started this action can confirm it.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (choice === "no") {
    await interaction.update({ content: "Cancelled.", components: [] }).catch(() => undefined);
    return;
  }

  await interaction.update({ content: `Executing **${action}**...`, components: [] }).catch(() => undefined);

  switch (action as ConfirmAction) {
    case "sleep":
      channelBroadcast(interaction, "Putting PC to sleep...");
      await sleep();
      break;
    case "restart":
      await restartPC(interaction);
      break;
    case "shutdown":
      await shutdownPC(interaction);
      break;
    default:
      logWarn(`Unknown confirm action ${action}`, "confirmations");
  }
}

/** Remove expired pending actions (called periodically + at startup). */
export function purgeExpiredConfirmations(): number {
  return cleanupExpiredPendingActions();
}

function channelBroadcast(interaction: BaseInteraction, content: string): void {
  const channel = interaction.channel;
  if (channel && "send" in channel) {
    (channel as { send: (c: string) => Promise<unknown> }).send(content).catch(() => undefined);
  }
}

async function restartPC(interaction: BaseInteraction): Promise<void> {
  const { restart } = await import("../system/index.js");
  channelBroadcast(interaction, "Restarting PC...");
  const res = await restart();
  if (!res.ok) {
    await (interaction as import("discord.js").ButtonInteraction)
      .followUp({ content: `Restart failed: ${res.error}`, ephemeral: true })
      .catch(() => undefined);
  }
}

async function shutdownPC(interaction: BaseInteraction): Promise<void> {
  const { shutdown } = await import("../system/index.js");
  channelBroadcast(interaction, "Shutting down PC...");
  const res = await shutdown();
  if (!res.ok) {
    await (interaction as import("discord.js").ButtonInteraction)
      .followUp({ content: `Shutdown failed: ${res.error}`, ephemeral: true })
      .catch(() => undefined);
  }
}
