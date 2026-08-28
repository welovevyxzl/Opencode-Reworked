import { SlashCommandBuilder, ChatInputCommandInteraction, AutocompleteInteraction, StringSelectMenuBuilder, ActionRowBuilder, EmbedBuilder, Colors } from "discord.js";
import * as oc from "../opencode/manager.js";
import { getProjectState, saveProjectState, getChannelBinding } from "../storage/index.js";
import { truncate } from "../utils/index.js";

export const data = new SlashCommandBuilder()
  .setName("model")
  .setDescription("Manage OpenCode models")
  .addSubcommand((s) => s.setName("list").setDescription("List available models"))
  .addSubcommand(
    (s) =>
      s
        .setName("set")
        .setDescription("Set model for this project")
        .addStringOption((o) => o.setName("model").setDescription("Model id").setRequired(true).setAutocomplete(true))
  )
  .addSubcommand((s) => s.setName("current").setDescription("Show current model for this project"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "list") {
    await interaction.deferReply({ ephemeral: true });
    const catalog = await oc.getModelCatalog();
    const all = catalog.reduce((n, p) => n + p.models.length, 0);
    if (all === 0) {
      await interaction.editReply({ content: "No models available from OpenCode." });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId("sb_model_pick")
      .setPlaceholder("Select a model")
      .addOptions(
        catalog
          .flatMap((p) => p.models)
          .slice(0, 25)
          .map((m) => ({ label: truncate(m.name || m.id, 80), value: m.id }))
      );
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

    const MAX_VALUE = 1000;
    const fields = [];
    for (const provider of catalog) {
      const entries = provider.models.map(
        (md) => `\`${md.id}\`` + (md.name && md.name !== md.id ? ` — ${md.name}` : "")
      );
      let value = entries.join("\n");
      if (value.length > MAX_VALUE) value = value.slice(0, MAX_VALUE - 3) + "...";
      fields.push({ name: `${provider.name} (${provider.models.length})`, value, inline: false });
    }

    const embed = new EmbedBuilder()
      .setColor(Colors.Blue)
      .setTitle(`Models (${all})`)
      .setDescription(truncate(catalog.map((p) => `**${p.name}** — ${p.models.length} models`).join("\n"), 2048))
      .addFields(fields.slice(0, 25))
      .setFooter({ text: "OpenCode Remote" });
    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  if (sub === "set") {
    const model = interaction.options.getString("model", true);
    const binding = getChannelBinding(interaction.channelId);
    if (!binding) {
      await interaction.reply({ content: "Bind a project to this channel first with `/use`.", ephemeral: true });
      return;
    }
    const state = getProjectState(binding.projectAlias) || {
      alias: binding.projectAlias,
      path: "",
      selectedModel: "",
      threadSessionMap: new Map(),
      autocodeEnabled: false,
      channelBindings: new Map(),
    };
    state.selectedModel = model;
    saveProjectState(state);
    await interaction.reply({ content: `✓ Model for **${binding.projectAlias}** set to \`${model}\`.`, ephemeral: true });
    return;
  }

  if (sub === "current") {
    const binding = getChannelBinding(interaction.channelId);
    const state = binding ? getProjectState(binding.projectAlias) : null;
    await interaction.reply({
      content: state?.selectedModel
        ? `Current model for **${binding?.projectAlias}**: \`${state.selectedModel}\``
        : "No model selected for this project. Use `/model set`.",
      ephemeral: true,
    });
  }
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const focused = interaction.options.getFocused();
  const models = await oc.getModels();
  const filtered = models.filter((m) => m.toLowerCase().includes(focused.toLowerCase())).slice(0, 25);
  await interaction.respond(filtered.map((m) => ({ name: truncate(m, 80), value: m })));
}