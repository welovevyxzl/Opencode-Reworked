import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";
import { loadConfig, saveConfig } from "../storage/index.js";
import { logWarn } from "../utils/logger.js";

export const data = new SlashCommandBuilder()
  .setName("voice")
  .setDescription("Control voice transcription for /code threads")
  .addSubcommand((s) => s.setName("status").setDescription("Show voice transcription status"))
  .addSubcommand(
    (s) =>
      s
        .setName("enable")
        .setDescription("Enable voice transcription")
        .addStringOption((o) => o.setName("openai_key").setDescription("OpenAI API key").setRequired(true))
  )
  .addSubcommand((s) => s.setName("disable").setDescription("Disable voice transcription"));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const config = loadConfig();
  if (!config) {
    await interaction.reply({ content: "No configuration. Run `ocr setup` first.", ephemeral: true });
    return;
  }

  if (sub === "status") {
    const enabled = config.voice.enabled;
    const hasKey = Boolean(config.voice.openaiApiKey);
    await interaction.reply({
      content: `Voice transcription: **${enabled ? "enabled" : "disabled"}**\nOpenAI key configured: **${hasKey ? "✓" : "never set / redacted"}**`,
      ephemeral: true,
    });
    return;
  }

  if (sub === "enable") {
    const key = interaction.options.getString("openai_key", true);
    config.voice.enabled = true;
    config.voice.openaiApiKey = key;
    saveConfig(config);
    await interaction.reply({ content: "✓ Voice transcription enabled. The key is stored locally in your config.", ephemeral: true });
    return;
  }

  if (sub === "disable") {
    config.voice.enabled = false;
    saveConfig(config);
    await interaction.reply({ content: "Voice transcription disabled.", ephemeral: true });
  }
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