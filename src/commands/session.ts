import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Colors,
  StringSelectMenuBuilder,
  ActionRowBuilder,
} from "discord.js";
import * as oc from "../opencode/manager.js";
import {
  getThreadSession,
  saveThreadSession,
  deleteThreadSession,
  getChannelBinding,
} from "../storage/index.js";
import { formatDuration, truncate } from "../utils/index.js";
import { getDatabaseRows } from "../storage/thrds.js";

export const data = new SlashCommandBuilder()
  .setName("session")
  .setDescription("Manage OpenCode sessions")
  .addSubcommand((s) => s.setName("list").setDescription("List sessions"))
  .addSubcommand((s) => s.setName("new").setDescription("Create a new session"))
  .addSubcommand((s) => s.setName("attach").setDescription("Attach a session to this thread"))
  .addSubcommand((s) => s.setName("detach").setDescription("Detach this thread from its session"))
  .addSubcommand((s) => s.setName("info").setDescription("Show current session info"))
  .addSubcommand((s) => s.setName("delete").setDescription("Delete a session"))
  .addSubcommand((s) =>
    s.setName("rename").setDescription("Rename a session").addStringOption((o) => o.setName("name").setDescription("New name").setRequired(true))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case "list":
      await listSessions(interaction);
      break;
    case "new":
      await newSession(interaction);
      break;
    case "attach":
      await attachSession(interaction);
      break;
    case "detach":
      await detachSession(interaction);
      break;
    case "info":
      await sessionInfo(interaction);
      break;
    case "delete":
      await deleteSessionCmd(interaction);
      break;
    case "rename":
      await renameSession(interaction);
      break;
  }
}

async function listSessions(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const sessions = await oc.getSessions();
  if (sessions.length === 0) {
    await interaction.editReply({ content: "No sessions yet." });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(Colors.Blue)
    .setFooter({ text: "OpenCode Remote" })
    .setTitle(`Sessions (${sessions.length})`);

  for (const s of sessions.slice(0, 10)) {
    const ts = getThreadSessionBySessionId(s.id);
    const title = s.title || `session ${s.id.slice(0, 8)}`;
    embed.addFields({
      name: truncate(title, 80),
      value: `\`${s.id.slice(0, 8)}\` · updated ${relative(s.updated)}${ts ? ` · thread <#${ts}>` : ""}`,
    });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("sb_session_attach")
    .setPlaceholder("Attach a session to this thread")
    .addOptions(
      sessions.slice(0, 25).map((s) => ({
        label: truncate((s.title || s.id.slice(0, 8)), 80),
        value: s.id,
        description: s.id.slice(0, 12),
      }))
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function newSession(interaction: ChatInputCommandInteraction): Promise<void> {
  const binding = getChannelBinding(interaction.channelId);
  const projectAlias = binding?.projectAlias || "default";
  const session = await oc.createSession(`New session in ${projectAlias}`);
  if (!session) {
    await interaction.reply({ content: "Failed to create session. Is OpenCode running?", ephemeral: true });
    return;
  }
  saveThreadSession(interaction.channelId, session.id, projectAlias, interaction.channelId);
  await interaction.reply({ content: `✓ Created session \`${session.id}\` and attached it to this thread.`, ephemeral: true });
}

async function attachSession(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessions = await oc.getSessions();
  if (sessions.length === 0) {
    await interaction.reply({ content: "No sessions to attach. Create one with `/session new`.", ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId("sb_session_attach")
    .setPlaceholder("Choose a session")
    .addOptions(
      sessions.slice(0, 25).map((s) => ({
        label: truncate((s.title || s.id.slice(0, 8)), 80),
        value: s.id,
        description: s.id.slice(0, 12),
      }))
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ content: "Select a session to attach to this thread:", components: [row], ephemeral: true });
}

async function detachSession(interaction: ChatInputCommandInteraction): Promise<void> {
  const ts = getThreadSession(interaction.channelId);
  if (!ts) {
    await interaction.reply({ content: "This thread has no session attached.", ephemeral: true });
    return;
  }
  deleteThreadSession(interaction.channelId);
  await interaction.reply({ content: "✓ Detached. Next prompt will create a fresh session.", ephemeral: true });
}

async function sessionInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  const ts = getThreadSession(interaction.channelId);
  if (!ts) {
    await interaction.reply({ content: "This thread has no session attached.", ephemeral: true });
    return;
  }
  const sessions = await oc.getSessions();
  const session = sessions.find((s) => s.id === ts.sessionId);
  const embed = new EmbedBuilder().setColor(Colors.Blue).setFooter({ text: "OpenCode Remote" });
  if (session) {
    embed.setTitle(session.title || "Session");
    embed.setDescription(`\`${session.id}\``);
    embed.addFields(
      { name: "Project", value: ts.projectAlias, inline: true },
      { name: "Updated", value: relative(session.updated), inline: true }
    );
  } else {
    embed.setTitle("Session (not found on server)");
    embed.setDescription(`\`${ts.sessionId}\``);
    embed.addFields({ name: "Project", value: ts.projectAlias, inline: true });
  }
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function deleteSessionCmd(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessions = await oc.getSessions();
  if (sessions.length === 0) {
    await interaction.reply({ content: "No sessions to delete.", ephemeral: true });
    return;
  }
  const select = new StringSelectMenuBuilder()
    .setCustomId("sb_session_delete")
    .setPlaceholder("Choose a session to delete")
    .addOptions(
      sessions.slice(0, 25).map((s) => ({
        label: truncate((s.title || s.id.slice(0, 8)), 80),
        value: s.id,
        description: s.id.slice(0, 12),
      }))
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.reply({ content: "Select a session to delete:", components: [row], ephemeral: true });
}

async function renameSession(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString("name", true);
  const ts = getThreadSession(interaction.channelId);
  if (!ts) {
    await interaction.reply({ content: "No session attached to this thread. Attach one first with /session attach.", ephemeral: true });
    return;
  }
  const ok = await oc.renameSession(ts.sessionId, name);
  if (!ok) {
    await interaction.reply({ content: "Rename failed. Is OpenCode reachable?", ephemeral: true });
    return;
  }
  await interaction.reply({ content: `✓ Renamed to \`${name}\`.` , ephemeral: true });
}

function getThreadSessionBySessionId(sessionId: string): string | null {
  for (const ts of getAllThreadSessions()) {
    if (ts.sessionId === sessionId) return ts.threadId;
  }
  return null;
}

function getAllThreadSessions(): Array<{ threadId: string; sessionId: string }> {
  return getDatabaseRows();
}

function relative(num: number): string {
  if (!num) return "unknown";
  return formatDuration(Date.now() - num) + " ago";
}