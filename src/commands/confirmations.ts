import { BaseInteraction, ButtonBuilder, ButtonStyle, ActionRowBuilder, type ButtonInteraction } from "discord.js";
import { checkAuth } from "../security/auth.js";
import { logInfo } from "../utils/logger.js";
import { sleep, cancelShutdown } from "../system/index.js";

const CONFIRM_TIMEOUT = 30000;

export const CONFIRM_TIMEOUT_MS = CONFIRM_TIMEOUT;

export function parseConfirmationId(
  customId: string
): { action: string; choice: string; key: string } | null {
  const match = customId.match(/^confirm_(sleep|restart|shutdown)_(yes|no)_(.+)$/);
  if (!match) return null;
  return { action: match[1], choice: match[2], key: match[3] };
}

interface PendingAction {
  action: "sleep" | "restart" | "shutdown";
  userId: string;
  expiresAt: number;
}

const pendingActions = new Map<string, PendingAction>();

export async function registerConfirmation(
  interaction: BaseInteraction,
  action: PendingAction["action"]
): Promise<void> {
  const key = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  pendingActions.set(key, { action, userId: interaction.user.id, expiresAt: Date.now() + CONFIRM_TIMEOUT });

  const confirm = new ButtonBuilder()
    .setCustomId(`confirm_${action}_yes_${key}`)
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("✓");
  const cancel = new ButtonBuilder()
    .setCustomId(`confirm_${action}_no_${key}`)
    .setLabel("Cancel")
    .setStyle(ButtonStyle.Secondary)
    .setEmoji("×");

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(confirm, cancel);

  try {
    if (interaction.isRepliable() && interaction.replied) {
      await interaction.editReply({ content: `⚠️ This will **${action.toUpperCase()}** the PC. Confirm within 30s.`, components: [row] });
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: `⚠️ This will **${action.toUpperCase()}** the PC. Confirm within 30s.`,
        components: [row],
        ephemeral: false,
      });
    }
  } catch (err) {
    logInfo(`Confirmation reply failed: ${err}`, "confirmations");
  }
  return;
}

export async function handleConfirmAction(interaction: BaseInteraction): Promise<void> {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;
  const parsed = parseConfirmationId(customId);
  if (!parsed) return;

  const { action, choice, key } = parsed;
  const pending = pendingActions.get(key);

  if (!pending) {
    await interaction.reply({ content: "Confirmation expired or already used.", ephemeral: true }).catch(() => undefined);
    return;
  }
  pendingActions.delete(key);

  if (Date.now() > pending.expiresAt) {
    await interaction.reply({ content: "Confirmation expired after 30 seconds. Run the command again.", ephemeral: true }).catch(() => undefined);
    return;
  }

  const auth = checkAuth(interaction.user.id);
  if (!auth.authorized || !auth.owner) {
    await interaction.reply({ content: "Only the owner can control the PC.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (choice === "no") {
    await interaction.update({ content: "Cancelled.", components: [] }).catch(() => undefined);
    return;
  }

  await interaction.update({ content: `Putting PC to sleep...`, components: [] }).catch(() => undefined);

  switch (action) {
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
  }
}

function channelBroadcast(interaction: BaseInteraction, content: string): void {
  const channel = interaction.channel;
  if (channel && "send" in channel) {
    (channel as { send: (c: string) => Promise<unknown> }).send(content).catch(() => undefined);
  }
}

async function restartPC(interaction: ButtonInteraction): Promise<void> {
  const { restart } = await import("../system/index.js");
  channelBroadcast(interaction, "Restarting PC in 15 seconds...");
  const res = await restart();
  if (!res.ok) {
    await interaction.followUp({ content: `Restart failed: ${res.error}`, ephemeral: true }).catch(() => undefined);
  }
}

async function shutdownPC(interaction: ButtonInteraction): Promise<void> {
  const { shutdown } = await import("../system/index.js");
  channelBroadcast(interaction, "Shutting down PC in 15 seconds...");
  const res = await shutdown();
  if (!res.ok) {
    await interaction.followUp({ content: `Shutdown failed: ${res.error}`, ephemeral: true }).catch(() => undefined);
  }
}

export async function cancelPendingShutdown(): Promise<void> {
  await cancelShutdown();
}