// ═══════════════════════════════════════════════════════════════
// Transcripción de notas de voz — usa Whisper de OpenAI.
// Las clientas dominicanas aman mandar audios; esto los convierte a
// texto para que el bot las atienda igual que un mensaje escrito.
//
// Requiere la variable de entorno OPENAI_API_KEY. Si no está, el bot
// usa el comportamiento anterior (pedir el mensaje por texto).
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ¿Está configurada la transcripción?
export function transcription_enabled() {
  return !!config.openai_api_key;
}

// Transcribe un archivo de audio a texto (español). Devuelve el texto o null.
export async function transcribe_audio(file_path, mime = "audio/ogg") {
  if (!config.openai_api_key) return null;
  try {
    const data = fs.readFileSync(file_path);
    const ext = (mime.split("/")[1] || "ogg").split(";")[0]; // ej: ogg, mpeg, mp4
    const form = new FormData();
    form.append("file", new Blob([data], { type: mime }), `audio.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "es"); // español (incluye dominicano)

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openai_api_key}` },
      body: form
    });

    if (!res.ok) {
      const errText = await res.text();
      logger.error({ status: res.status, errText: errText.slice(0, 300) }, "Error transcribiendo audio (Whisper)");
      return null;
    }
    const json = await res.json();
    const text = (json.text || "").trim();
    return text || null;
  } catch (err) {
    logger.error({ err: err.message }, "Excepción transcribiendo audio");
    return null;
  }
}
