import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, Colors } from "discord.js";
import { getQueueSnapshot, clearAllQueue, removeItem, queueSettings, updateSettings, isQueuePaused, setQueuePaused } from "../opencode/engine.js";
import { Icons } from "../discord/ui.js";
import { truncate } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("queue")
  .setDescription("Manage the prompt queue")
  .addSubcommand((s) => s.setName("list").setDescription("List queued prompts"))
  .addSubcommand((s) => s.setName("pause").setDescription("Pause the queue"))
  .addSubcommand((s) => s.setName("resume").setDescription("Resume the queue"))
  .addSubcommand((s) => s.setName("clear").setDescription("Clear the queue"))
  .addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Remove an item from the queue")
      .addStringOption((o) => o.setName("id").setDescription("Queue item id").setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName("settings")
      .setDescription("View or change queue settings")
      .addBooleanOption((o) => o.setName("continue_on_failure").setDescription("Continue to next item after a failure").setRequired(false))
      .addBooleanOption((o) => o.setName("fresh_context").setDescription("Use a fresh context for each queued prompt").setRequired(false))
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();

  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });
    const items = getQueueSnapshot();
    if (items.length === 0) {
      await interaction.editReply({ content: "Queue is empty." });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`Queue (${items.length})`)
      .setFooter({ text: "OpenCode Remote" });
    for (const item of items.filter((i) => i.status === "queued" || i.status === "running")) {
      const running = item.status === "running";
      embed.addFields({
        name: `${running ? Icons.running : Icons.queued} #${item.position} ${running ? "(running)" : ""}`,
        value: `\`${item.id.slice(0, 8)}\` · ${truncate(item.prompt, 120)}`,
      });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === "clear") {
    clearAllQueue();
    await interaction.reply({ content: "✓ Queue cleared.", ephemeral: true });
    return;
  }

  if (sub === "remove") {
    const id = interaction.options.getString("id", true);
    removeItem(id);
    await interaction.reply({ content: "✓ Removed from queue.", ephemeral: true });
    return;
  }

  if (sub === "pause") {
    setQueuePaused(true);
    await interaction.reply({ content: "Queue paused.", ephemeral: true });
    return;
  }

  if (sub === "resume") {
    setQueuePaused(false);
    void import("../opencode/engine.js").then((e) => e.pumpQueue());
    await interaction.reply({ content: "✓ Queue resumed.", ephemeral: true });
    return;
  }

  if (sub === "settings") {
    const cont = interaction.options.getBoolean("continue_on_failure");
    const fresh = interaction.options.getBoolean("fresh_context");
    if (cont !== null || fresh !== null) {
      await updateSettings({
        continueOnFailure: cont ?? undefined,
        freshContext: fresh ?? undefined,
      });
      await interaction.reply({ content: "✓ Queue settings updated.", ephemeral: true });
    } else {
      const s = queueSettings();
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setColor(Colors.Blue)
            .setTitle("Queue settings")
            .addFields(
              { name: "Continue on failure", value: s.continueOnFailure ? "✓ enabled" : "disabled", inline: true },
              { name: "Fresh context", value: s.freshContext ? "✓ enabled" : "disabled", inline: true },
              { name: "Paused", value: isQueuePaused() ? "✓ paused" : "active", inline: true }
            )
            .setFooter({ text: "OpenCode Remote" }),
        ],
        ephemeral: true,
      });
    }
  }
}