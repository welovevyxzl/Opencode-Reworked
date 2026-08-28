import { BaseInteraction, MessagePayload, MessageCreateOptions } from "discord.js";
import { loadConfig, getChannelBinding, getThreadSession } from "../storage/index.js";
import { logWarn } from "../utils/logger.js";
import { checkAuth } from "../security/auth.js";
import { stopCurrentJob, queuePrompt, getCurrentJob } from "../opencode/engine.js";
import { deleteThreadSession } from "../storage/index.js";
import { deleteSession } from "../opencode/manager.js";
import { getDiff as gitGetDiff, diffToFile, stageAll, commit, push, getCurrentBranch, deleteWorktree } from "../git/index.js";
import { createPullRequest } from "../github/index.js";
import { handleConfirmAction } from "./confirmations.js";

async function loadProjectForInteraction(interaction: BaseInteraction) {
  const { getProjectState } = await import("../storage/index.js");
  if (!interaction.channelId) return null;
  const binding = getChannelBinding(interaction.channelId);
  return binding ? getProjectState(binding.projectAlias) : null;
}

export function registerComponentHandlers(): void {
  // stateless; registry exists for shape
}

function channelSend(channel: BaseInteraction["channel"], payload: string | (MessagePayload | MessageCreateOptions)) {
  if (channel && "send" in channel) {
    channel.send(payload as MessageCreateOptions).catch(() => undefined);
  }
}

export async function handleComponent(interaction: BaseInteraction): Promise<void> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const auth = checkAuth(interaction.user.id);
  if (!auth.authorized) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: "You are not authorized to control this machine.", ephemeral: true });
    }
    return;
  }

  const id = interaction.customId;

  if (id.startsWith("confirm_")) {
    await handleConfirmAction(interaction);
    return;
  }

  if (id === "oc_stop") {
    await interaction.deferUpdate().catch(() => undefined);
    const res = await stopCurrentJob();
    await interaction.followUp({ content: res.ok ? "Stopping..." : res.message, ephemeral: true }).catch(() => undefined);
    return;
  }

  if (id === "oc_regen") {
    await interaction.deferUpdate().catch(() => undefined);
    if (getCurrentJob()) {
      await interaction.followUp({ content: "A task is already running.", ephemeral: true }).catch(() => undefined);
      return;
    }
    const ts = getThreadSession(interaction.channelId);
    if (!ts) {
      await interaction.followUp({ content: "No session attached to this thread.", ephemeral: true }).catch(() => undefined);
      return;
    }
    // Re-queue the last prompt - we'd need to store it. For now, ask user to re-prompt.
    await interaction.followUp({ content: "Regenerate: please send your prompt again, or use Continue.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (id === "oc_continue") {
    await interaction.deferUpdate().catch(() => undefined);
    if (!interaction.isButton()) return;
    if (getCurrentJob()) {
      await interaction.followUp({ content: "A task is already running.", ephemeral: true }).catch(() => undefined);
      return;
    }
    const ts = getThreadSession(interaction.channelId);
    if (!ts) {
      await interaction.followUp({ content: "No session attached to this thread. Use Continue only on an OpenCode thread.", ephemeral: true }).catch(() => undefined);
      return;
    }
    void queuePrompt({
      prompt: "Continue with the current task. Pick up where you left off and keep going.",
      channelId: interaction.channelId,
      threadId: interaction.channelId,
      projectAlias: ts.projectAlias,
      sessionId: ts.sessionId,
    });
    await interaction.followUp({ content: "Continuation queued.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (id === "oc_new") {
    await interaction.deferUpdate().catch(() => undefined);
    deleteThreadSession(interaction.channelId);
    await interaction.followUp({ content: "New session. Next prompt will create a fresh context.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (id === "oc_diff") {
    await interaction.deferUpdate().catch(() => undefined);
    const state = await loadProjectForInteraction(interaction);
    if (!state) {
      await interaction.followUp({ content: "No project bound to this channel.", ephemeral: true }).catch(() => undefined);
      return;
    }
    const res = await gitGetDiff(state.path);
    if (!res.ok || !res.output) {
      await interaction.followUp({ content: "No changes to show.", ephemeral: true }).catch(() => undefined);
      return;
    }
    const file = await diffToFile(state.path, res.output);
    channelSend(interaction.channel, { content: "Git diff:", files: [file] });
    await interaction.followUp({ content: "Diff attached.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (id === "gc_stage_all") {
    if (!interaction.isButton()) return;
    await interaction.deferUpdate().catch(() => undefined);
    const binding = getChannelBinding(interaction.channelId);
    const state = binding ? (await loadProjectForInteraction(interaction)) : null;
    if (!state?.path) {
      await interaction.followUp({ content: "No project bound.", ephemeral: true }).catch(() => undefined);
      return;
    }
    const { popPendingCommitMessage } = await import("./git.js");
    const message = popPendingCommitMessage(interaction.channelId) || "Commit";
    const stageRes = await stageAll(state.path);
    if (!stageRes.ok) {
      await interaction.followUp({ content: `× Failed to stage: ${stageRes.error}`, ephemeral: true }).catch(() => undefined);
      return;
    }
    const commitRes = await commit(state.path, message);
    if (!commitRes.ok) {
      await interaction.followUp({ content: `× Commit failed: ${commitRes.error}`, ephemeral: true }).catch(() => undefined);
      return;
    }
    channelSend(interaction.channel, `✓ Commit made: \`${message}\``);
    await interaction.followUp({ content: "Done.", ephemeral: true }).catch(() => undefined);
    return;
  }

  if (id.startsWith("wb_")) {
    if (!interaction.isButton()) return;
    await interaction.deferUpdate().catch(() => undefined);
    await handleWorktreeButton(id, interaction);
    return;
  }

  if (id.startsWith("sb_use_") || id.startsWith("sb_project_")) {
    if (!interaction.isStringSelectMenu()) return;
    const projectAlias = interaction.values[0].replace(/^sb_(use|project)_/, "");
    const binding = getChannelBinding(interaction.channelId) || {
      channelId: interaction.channelId,
      projectAlias,
      autocodeEnabled: false,
      threadSessionMap: new Map(),
    };
    binding.projectAlias = projectAlias;
    const { saveChannelBinding } = await import("../storage/index.js");
    saveChannelBinding(binding);
    await interaction.reply({ content: `Bound this channel to \`${projectAlias}\`.`, ephemeral: true });
    return;
  }

  if (id === "sb_session_attach") {
    if (!interaction.isStringSelectMenu()) return;
    const sessionId = interaction.values[0];
    await attachSession(interaction.channelId, sessionId);
    await interaction.reply({ content: `Attached session \`${sessionId.slice(0, 8)}…\`.`, ephemeral: true });
    return;
  }

  if (id === "sb_session_delete") {
    if (!interaction.isStringSelectMenu()) return;
    const sessionId = interaction.values[0];
    const ok = await deleteSession(sessionId);
    await interaction.reply({ content: ok ? `Deleted session \`${sessionId.slice(0, 8)}…\`.` : "Failed to delete session.", ephemeral: true });
    return;
  }

  if (id.startsWith("sb_session_")) {
    if (!interaction.isStringSelectMenu()) return;
    const sessionId = interaction.values[0].replace("sb_session_", "");
    await attachSession(interaction.channelId, sessionId);
    await interaction.reply({ content: `Attached session \`${sessionId}\`.`, ephemeral: true });
    return;
  }

  if (id.startsWith("sb_model_")) {
    if (!interaction.isStringSelectMenu()) return;
    const model = interaction.values[0].replace("sb_model_", "");
    const { saveProjectState } = await import("../storage/index.js");
    const state = await loadProjectForInteraction(interaction);
    if (state) {
      state.selectedModel = model;
      saveProjectState(state);
      await interaction.reply({ content: `Model set to \`${model}\`.` , ephemeral: true });
    } else {
      await interaction.reply({ content: "Set a project first with /use.", ephemeral: true });
    }
    return;
  }

  if (id.startsWith("sn_more_")) {
    if (!interaction.isButton()) return;
    const state = await loadProjectForInteraction(interaction);
    if (!state) {
      await interaction.reply({ content: "No project bound.", ephemeral: true });
      return;
    }
    const res = await gitGetDiff(state.path);
    if (!res.ok) {
      await interaction.reply({ content: res.error || "Diff failed", ephemeral: true });
      return;
    }
    const file = await diffToFile(state.path, res.output);
    channelSend(interaction.channel, { content: "Full diff:", files: [file] });
    await interaction.reply({ content: "Full diff attached.", ephemeral: true });
    return;
  }

  logWarn(`Unhandled component: ${id}`, "components");
}

async function attachSession(threadId: string, sessionId: string) {
  const { saveThreadSession } = await import("../storage/index.js");
  const ts = getThreadSession(threadId);
  const projectAlias = ts?.projectAlias || (await loadDefaultProject()) || "default";
  saveThreadSession(threadId, sessionId, projectAlias, threadId);
}

async function handleWorktreeButton(id: string, interaction: any): Promise<void> {
  const binding = getChannelBinding(interaction.channelId);
  const state = binding ? (await loadProjectForInteraction(interaction)) : null;
  if (!state?.path) {
    await interaction.followUp({ content: "No project bound.", ephemeral: true }).catch(() => undefined);
    return;
  }

  switch (id) {
    case "wb_diff": {
      const res = await gitGetDiff(state.path);
      if (!res.ok || !res.output) {
        await interaction.followUp({ content: "No changes.", ephemeral: true }).catch(() => undefined);
      } else {
        const file = await diffToFile(state.path, res.output);
        channelSend(interaction.channel, { content: "Worktree diff:", files: [file] });
        await interaction.followUp({ content: "Attached.", ephemeral: true }).catch(() => undefined);
      }
      break;
    }
    case "wb_commit": {
      const branch = await getCurrentBranch(state.path);
      const message = `Work on ${branch}`;
      await stageAll(state.path);
      const res = await commit(state.path, message);
      if (!res.ok) {
        await interaction.followUp({ content: `× ${res.error}`, ephemeral: true }).catch(() => undefined);
      } else {
        channelSend(interaction.channel, `✓ Committed \`${message}\``);
      }
      break;
    }
    case "wb_push": {
      const branch = await getCurrentBranch(state.path);
      const res = await push(state.path, "origin", branch);
      if (!res.ok) {
        await interaction.followUp({ content: `× ${res.error}`, ephemeral: true }).catch(() => undefined);
      } else {
        channelSend(interaction.channel, `✓ Pushed \`${branch}\``);
      }
      break;
    }
    case "wb_pr": {
      const branch = await getCurrentBranch(state.path);
      const res = await createPullRequest({ title: `Work: ${branch}`, head: branch });
      if (!res.ok) {
        await interaction.followUp({ content: `× ${res.error}`, ephemeral: true }).catch(() => undefined);
      } else {
        channelSend(interaction.channel, `✓ PR created: ${res.url || "see gh"}`);
      }
      break;
    }
    case "wb_delete": {
      const res = await deleteWorktree(state.path, state.path);
      if (!res.ok) {
        await interaction.followUp({ content: `× ${res.error}`, ephemeral: true }).catch(() => undefined);
      } else {
        channelSend(interaction.channel, "Worktree deleted.");
      }
      break;
    }
  }
}

async function loadDefaultProject(): Promise<string | null> {
  const config = loadConfig();
  if (config?.projects.registered[0]) return config.projects.registered[0].alias;
  return null;
}