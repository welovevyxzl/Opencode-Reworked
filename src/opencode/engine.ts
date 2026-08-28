import {
  Client,
  ThreadChannel,
  ButtonStyle,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  Message,
} from "discord.js";
import {
  loadConfig,
  getProjectState,
  getChannelBinding,
  saveChannelBinding,
  getThreadSession,
  saveThreadSession,
  addToQueue,
  getPendingQueue,
  updateQueueItem,
  getQueueItem,
  getAllQueue,
  clearQueue,
  removeFromQueue,
  saveProjectState,
} from "../storage/index.js";
import { logInfo } from "../utils/logger.js";
import * as oc from "./manager.js";
import { getClient } from "../discord/bot.js";
import { generateId, formatDuration } from "../utils/index.js";
import { Icons, baseEmbed } from "../discord/ui.js";

let currentJob: { itemId: string; sessionId: string } | null = null;
let cancelling = false;
let currentStatusMessageId: string | null = null;
let lastMeaningful: string | null = null;
let lastMeaningfulTs = 0;
let startedAt = 0;
let currentModel = "";
let paused = false;

export function getCurrentJob(): { itemId: string; sessionId: string } | null {
  return currentJob;
}

export function hasActiveJob(): boolean {
  return currentJob !== null;
}

export function isQueuePaused(): boolean {
  return paused;
}

export function setQueuePaused(value: boolean): void {
  paused = value;
}

export function queueSettings() {
  const config = loadConfig();
  return {
    continueOnFailure: config?.queue.continueOnFailure ?? true,
    freshContext: config?.queue.freshContext ?? false,
  };
}

export async function updateSettings(opts: { continueOnFailure?: boolean; freshContext?: boolean }): Promise<void> {
  const config = loadConfig();
  if (!config) return;
  if (opts.continueOnFailure !== undefined) config.queue.continueOnFailure = opts.continueOnFailure;
  if (opts.freshContext !== undefined) config.queue.freshContext = opts.freshContext;
  const { saveConfig: sc } = await import("../storage/index.js");
  sc(config);
}

export async function queuePrompt(opts: {
  prompt: string;
  channelId: string;
  threadId: string;
  projectAlias: string;
  sessionId?: string;
  model?: string;
  freshContext?: boolean;
}): Promise<string> {
  const item = {
    id: generateId(),
    prompt: opts.prompt,
    channelId: opts.channelId,
    threadId: opts.threadId,
    projectAlias: opts.projectAlias,
    sessionId: opts.sessionId,
    addedAt: Date.now(),
    status: "queued" as const,
  };
  addToQueue(item);
  if (opts.model) {
    const state = getProjectState(opts.projectAlias);
    if (state) {
      state.selectedModel = opts.model;
      saveProjectState(state);
    }
  }
  void pumpQueue();
  return item.id;
}

export async function pumpQueue(): Promise<void> {
  if (currentJob || paused) return;

  const config = loadConfig();
  if (!config) return;

  const next = getPendingQueue()[0];
  if (!next) return;

  const queueConf = config.queue || { continueOnFailure: true, freshContext: false };
  const sessionId = !queueConf.freshContext && next.sessionId ? next.sessionId : "";

  currentJob = { itemId: next.id, sessionId };
  cancelling = false;
  currentStatusMessageId = null;
  startedAt = Date.now();
  currentModel = "";

  updateQueueItem(next.id, { status: "running" });
  logInfo(`Starting queue item ${next.id}`, "engine", { prompt: next.prompt.slice(0, 80) });

  await runPrompt(next);
}

async function runPrompt(item: import("../types/index.js").QueueItem): Promise<void> {
  const client = getClientSafe();
  if (!client) {
    finishJob(item.id, false, "Discord client not available");
    return;
  }

  const binding = getChannelBinding(item.channelId);
  const thread = client.channels.cache.get(item.threadId) as ThreadChannel | undefined;
  const state = getProjectState(item.projectAlias);
  const registered = loadConfig()?.projects?.registered?.find((p) => p.alias === item.projectAlias);
  const directory = state?.path?.trim() || registered?.path?.trim() || undefined;

  let sessionId = item.sessionId || "";
  const ts = getThreadSession(item.threadId);
  if (!sessionId && ts?.sessionId) {
    sessionId = ts.sessionId;
  }

  if (!sessionId) {
    const created = await oc.createSession(`Discord · ${item.projectAlias}`, directory);
    if (!created) {
      finishJob(item.id, false, "Failed to create an OpenCode session. Is OpenCode healthy? Run /doctor.");
      return;
    }
    sessionId = created.id;
    saveThreadSession(item.threadId, sessionId, item.projectAlias, binding?.channelId || item.channelId);
    if (binding) {
      binding.activeSessionId = sessionId;
      saveChannelBinding(binding);
    }
    updateQueueItem(item.id, { sessionId });
  }

  const statusMessage = await sendOrUpdateStatus(thread, sessionId, item);
  if (statusMessage && !currentStatusMessageId) {
    currentStatusMessageId = statusMessage.id;
  }

  const model = state?.selectedModel || undefined;

  const res = await oc.sendPrompt({
    sessionId,
    prompt: item.prompt,
    directory,
    model,
    onEvent: (event) => {
      if (event.type === "finish") {
        lastMeaningful = event.message || "finished";
        lastMeaningfulTs = Date.now();
      }
      if (event.file) {
        lastMeaningful = `edited ${event.file.slice(-60)}`;
        lastMeaningfulTs = Date.now();
      }
      if (Date.now() - lastMeaningfulTs < 2000) {
        void sendOrUpdateStatus(thread, sessionId, item);
      }
    },
  });

  if (res.ok) {
    finishJob(item.id, true, res.output);
  } else {
    finishJob(item.id, false, res.error || "OpenCode prompt failed");
  }
}

async function canSendTo(thread: ThreadChannel | undefined): Promise<boolean> {
  if (!thread) return false;
  const sendable = (thread as unknown as { isSendable?: () => boolean }).isSendable;
  if (typeof sendable === "function") return sendable.call(thread);
  return Boolean(thread.guild);
}

async function sendOrUpdateStatus(
  thread: ThreadChannel | undefined,
  sessionId: string,
  item: import("../types/index.js").QueueItem
): Promise<Message | null> {
  const client = getClientSafe();
  if (!client || !(await canSendTo(thread))) return null;
  const embed = buildStatusEmbed(sessionId, item);
  if (currentStatusMessageId) {
    try {
      const message = await thread!.messages.fetch(currentStatusMessageId);
      if (message) {
        await message.edit({ embeds: [embed], components: buildControls() });
        return message;
      }
    } catch {
      // message gone, send a new one
    }
  }
  try {
    const msg = await thread!.send({ embeds: [embed], components: buildControls() });
    currentStatusMessageId = msg.id;
    return msg;
  } catch {
    return null;
  }
}

function buildStatusEmbed(sessionId: string, item: import("../types/index.js").QueueItem): EmbedBuilder {
  const elapsed = formatDuration(Date.now() - startedAt);
  const state = getProjectState(item.projectAlias);
  const statusLine = cancelling
    ? `${Icons.fail} Cancelling...`
    : `${Icons.running} Working`;

  return baseEmbed(Colors.Blue)
    .setTitle("OpenCode")
    .setDescription(item.prompt.slice(0, 400) || "*no prompt*")
    .addFields(
      { name: "Project", value: `\`${item.projectAlias}\``, inline: true },
      { name: "Model", value: currentModel || state?.selectedModel || "default", inline: true },
      { name: "Session", value: `\`${sessionId.slice(0, 8)}\``, inline: true },
      { name: "State", value: statusLine, inline: true },
      { name: "Elapsed", value: elapsed, inline: true },
      { name: "Action", value: lastMeaningful ? `\`${lastMeaningful}\`` : "*starting...*", inline: false }
    );
}

function buildControls() {
  const stop = new ButtonBuilder()
    .setCustomId("oc_stop")
    .setLabel("Stop")
    .setStyle(ButtonStyle.Danger)
    .setEmoji("■");
  const cont = new ButtonBuilder()
    .setCustomId("oc_continue")
    .setLabel("Continue")
    .setStyle(ButtonStyle.Primary);
  const news = new ButtonBuilder()
    .setCustomId("oc_new")
    .setLabel("New Session")
    .setStyle(ButtonStyle.Secondary);
  const diff = new ButtonBuilder()
    .setCustomId("oc_diff")
    .setLabel("Diff")
    .setStyle(ButtonStyle.Secondary);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(stop, cont, news, diff)];
}

function getClientSafe(): Client | null {
  try {
    return getClient();
  } catch {
    return null;
  }
}

function finishJob(itemId: string, ok: boolean, result: string): void {
  updateQueueItem(itemId, { status: ok ? "completed" : "failed", result });
  const threadId = getQueueItem(itemId)?.threadId || null;
  currentJob = null;
  currentStatusMessageId = null;
  lastMeaningful = null;
  void postCompletion(threadId, ok, result);
}

async function postCompletion(threadId: string | null, ok: boolean, result: string): Promise<void> {
  const client = getClientSafe();
  if (!client || !threadId) return;
  const thread = client.channels.cache.get(threadId) as ThreadChannel | undefined;
  if (!(await canSendTo(thread))) return;

  const embed = baseEmbed(ok ? Colors.Green : Colors.Red)
    .setTitle(ok ? `${Icons.ok} Done` : `${Icons.fail} Failed`)
    .setDescription(result ? result.slice(0, 4000) : "(no output)");

  try {
    await thread!.send({ embeds: [embed] });
  } catch {
    // ignore
  }
}

export async function stopCurrentJob(): Promise<{ ok: boolean; message: string }> {
  if (!currentJob) return { ok: false, message: "No task is currently running." };
  cancelling = true;
  await oc.cancelSession(currentJob.sessionId);
  return { ok: true, message: "Cancellation requested. The current task will stop shortly." };
}

export function getQueueSnapshot() {
  return getAllQueue().map((item, index) => ({ ...item, position: index + 1 }));
}

export function clearAllQueue(): void {
  clearQueue();
  logInfo("Queue cleared", "engine");
}

export function removeItem(id: string): void {
  removeFromQueue(id);
}

export function configOpenCodeManager(): void {
  const config = loadConfig();
  if (config) oc.configure(config);
}

export async function retryQueueItem(id: string): Promise<void> {
  const item = getQueueItem(id);
  if (!item) return;
  updateQueueItem(id, { status: "queued", error: undefined });
  void pumpQueue();
}