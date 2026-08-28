import { SlashCommandBuilder, ChatInputCommandInteraction, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, Colors } from "discord.js";
import { loadConfig, saveConfig } from "../storage/index.js";
import { logWarn } from "../utils/logger.js";
import { successEmbed, errorEmbed, baseEmbed } from "../discord/ui.js";

export const data = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("Control voice transcription for /code threads")
  .addSubcommand((s) => s.setName("status").setDescription("Show voice transcription status"))
  .addSubcommand((s) => s.setName("enable").setDescription("Enable voice transcription (enter key via modal)"))
  .addSubcommand((s) => s.setName("disable").setDescription("Disable voice transcription"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const config = loadConfig();
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed("No configuration", "Run `ocr setup` first.")], ephemeral: true });
    return;
  }

  if (sub === "status") {
    const enabled = config.voice.enabled;
    const hasKey = Boolean(config.voice.openaiApiKey);
    await interaction.reply({
      embeds: [
        baseEmbed(enabled ? Colors.Green : Colors.Grey)
          .setTitle("Voice Transcription")
          .addFields(
            { name: "Status", value: enabled ? "✅ Enabled" : "⚪ Disabled", inline: true },
            { name: "OpenAI Key", value: hasKey ? "✅ Configured" : "❌ Not set", inline: true },
          )
          .setFooter({ text: "Use /voice enable to set up" }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (sub === "enable") {
    const modal = new ModalBuilder()
      .setCustomId("voice_key_modal")
      .setTitle("Configure Voice Transcription");

    const keyInput = new TextInputBuilder()
      .setCustomId("openai_key_input")
      .setLabel("OpenAI API Key")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder("sk-...")
      .setMinLength(20);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(keyInput));
    await interaction.showModal(modal);
    return;
  }

  if (sub === "disable") {
    config.voice.enabled = false;
    saveConfig(config);
    await interaction.reply({ embeds: [successEmbed("Voice transcription disabled")], ephemeral: true });
  }
}

export async function handleVoiceModalSubmit(interaction: import("discord.js").ModalSubmitInteraction): Promise<void> {
  const key = interaction.fields.getTextInputValue("openai_key_input");
  if (!key || key.length < 20) {
    await interaction.reply({ embeds: [errorEmbed("Invalid key", "The API key looks too short.")], ephemeral: true });
    return;
  }
  const config = loadConfig();
  if (!config) {
    await interaction.reply({ embeds: [errorEmbed("No configuration", "Run `ocr setup` first.")], ephemeral: true });
    return;
  }
  config.voice.enabled = true;
  config.voice.openaiApiKey = key;
  saveConfig(config);
  await interaction.reply({ embeds: [successEmbed("Voice transcription enabled", "Your OpenAI key is stored locally in the config file.")], ephemeral: true });
}

export async function transcribeVoice(audioUrl: string): Promise<string | null> {
  const config = loadConfig();
  const apiKey = config?.voice.openaiApiKey;
  if (!config?.voice.enabled || !apiKey) {
    logWarn("Voice transcription not configured", "voice");
    return null;
  }
  try {
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) {
      logWarn(`Failed to download voice message: ${audioRes.status}`, "voice");
      return null;
    }
    const audioBuf = Buffer.from(await audioRes.arrayBuffer());
    const ext = (audioRes.url.split(".").pop() || "ogg").split("?")[0];
    const body = new FormData();
    body.append("model", "whisper-1");
    body.append(
      "file",
      new Blob([audioBuf], { type: `audio/${ext}` }),
      `voice.${ext}`
    );
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body,
    });
    if (!res.ok) {
      logWarn(`Whisper transcription failed: ${res.status}`, "voice");
      return null;
    }
    const json = (await res.json()) as { text?: string };
    return json.text || null;
  } catch (err) {
    logWarn(`Voice transcription error: ${String(err)}`, "voice");
    return null;
  }
}