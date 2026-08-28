import { Message, ThreadChannel } from "discord.js";
import {
  getChannelBinding,
  loadConfig,
  getThreadSession,
  isAuthorized,
} from "../storage/index.js";
import { queuePrompt } from "../opencode/engine.js";
import { logDebug } from "../utils/logger.js";
import { transcribeVoice } from "./voice.js";

export function registerMessageHandlers(): void {
  // handlers are stateless; the registry exists to satisfy the call shape
}

export async function handleMessage(message: Message): Promise<void> {
  if (message.author.bot) return;
  if (!isAuthorized(message.author.id)) return;

  const channel = message.channel;
  const thread = channel instanceof ThreadChannel ? channel : null;
  if (!thread) return;

  const binding = getChannelBinding(channel.id);
  const parentBinding = thread.parentId ? getChannelBinding(thread.parentId) : null;

  const autocodeEnabled =
    binding?.autocodeEnabled ||
    (parentBinding?.autocodeEnabled ?? false);

  const useBinding = binding || parentBinding;
  if (!useBinding) return;

  const ts = getThreadSession(thread.id);

  const config = loadConfig();

  if (message.attachments.size > 0 && config?.voice.enabled) {
    const audio = message.attachments.first();
    if (audio && audio.contentType?.startsWith("audio/") && thread.parentId && autocodeEnabled) {
      const text = await transcribeVoice(audio.url);
      if (!text) return;
      await queuePrompt({
        prompt: text,
        channelId: thread.parentId,
        threadId: thread.id,
        projectAlias: useBinding.projectAlias,
        sessionId: ts?.sessionId,
      });
      await thread.send("voice message").catch(() => undefined);
      return;
    }
  }

  if (autocodeEnabled && thread) {
    const content = message.cleanContent;
    if (!content || content.startsWith("/") || content.length < 2) return;
    logDebug(`Passthrough message in ${thread.id}`, "passthrough", { len: content.length });
    await queuePrompt({
      prompt: content,
      channelId: thread.parentId || thread.id,
      threadId: thread.id,
      projectAlias: useBinding.projectAlias,
      sessionId: ts?.sessionId,
    });
    thread.send(`✓ queued`).catch(() => undefined);
  }
}