// ═══════════════════════════════════════════════════════════════
// Transcripción de notas de voz — usa Google Cloud Speech-to-Text.
// Reusa la MISMA cuenta de servicio de Google Sheets (no necesita key
// nueva): GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY.
//
// Requiere en el proyecto de Google Cloud:
//   - API "Cloud Speech-to-Text" habilitada
//   - Facturación (billing) habilitada
//   - La cuenta de servicio con permiso para consumir el API
// Si algo falta, la transcripción devuelve null y el bot pide el texto.
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import { execFile } from "child_process";
import { google } from "googleapis";
import { config } from "./config.js";
import { logger } from "./logger.js";

let _auth = null;
function get_auth() {
  if (_auth) return _auth;
  if (!config.sheets.service_account_email || !config.sheets.private_key) return null;
  _auth = new google.auth.JWT(
    config.sheets.service_account_email,
    null,
    config.sheets.private_key,
    ["https://www.googleapis.com/auth/cloud-platform"]
  );
  return _auth;
}

// ¿Hay credenciales de Google para intentar transcribir?
export function transcription_enabled() {
  return !!(config.sheets.service_account_email && config.sheets.private_key);
}

// Mapea el mime de Twilio al encoding de Google Speech-to-Text.
function pick_encoding(mime) {
  const m = (mime || "").toLowerCase();
  if (m.includes("ogg") || m.includes("opus")) return "OGG_OPUS";
  if (m.includes("amr-wb")) return "AMR_WB";
  if (m.includes("amr")) return "AMR";
  if (m.includes("mpeg") || m.includes("mp3")) return "MP3";
  if (m.includes("wav") || m.includes("x-wav")) return "LINEAR16";
  if (m.includes("flac")) return "FLAC";
  return null; // dejar que Google intente detectar
}

// PLAN B: convierte el audio a WAV 16k mono con ffmpeg (formato que Google
// siempre acepta). Cubre opus raros, audios de otras apps, etc. null si falla.
function to_wav16k(src_path) {
  const out = src_path + ".16k.wav";
  return new Promise(resolve => {
    execFile("ffmpeg", ["-y", "-i", src_path, "-ar", "16000", "-ac", "1", "-f", "wav", out],
      { timeout: 20000 }, (err) => resolve(!err && fs.existsSync(out) ? out : null));
  });
}

// Transcribe un archivo de audio a texto (español dominicano). null si falla.
// Intenta 1º con el formato original; si Google devuelve vacío, reintenta
// convirtiendo a WAV 16k con ffmpeg (mucho más tolerante).
export async function transcribe_audio(file_path, mime = "audio/ogg") {
  const first = await transcribe_once(file_path, mime);
  if (first) return first;
  const wav = await to_wav16k(file_path);
  if (!wav) return null;
  logger.info({ file: wav }, "🎤 Reintentando transcripción con WAV 16k (ffmpeg)");
  return await transcribe_once(wav, "audio/wav");
}

async function transcribe_once(file_path, mime = "audio/ogg") {
  const auth = get_auth();
  if (!auth) return null;
  try {
    const tokenResp = await auth.getAccessToken();
    const token = tokenResp?.token || tokenResp;
    if (!token) { logger.error("No se obtuvo token de Google para STT"); return null; }

    const audioBytes = fs.readFileSync(file_path).toString("base64");
    const encoding = pick_encoding(mime);

    const recognitionConfig = {
      languageCode: "es-DO", // español de República Dominicana
      alternativeLanguageCodes: ["es-US", "es-419"],
      enableAutomaticPunctuation: true
    };
    if (encoding) {
      recognitionConfig.encoding = encoding;
      // Google exige el sample rate para Opus. Las notas de voz de WhatsApp
      // son OGG_OPUS a 16 kHz (VERIFICADO con audio real: 16000 transcribe
      // perfecto, 48000 devuelve vacío). AMR=8kHz, AMR-WB=16kHz.
      if (encoding === "OGG_OPUS") recognitionConfig.sampleRateHertz = 16000;
      else if (encoding === "AMR") recognitionConfig.sampleRateHertz = 8000;
      else if (encoding === "AMR_WB") recognitionConfig.sampleRateHertz = 16000;
    }

    const res = await fetch("https://speech.googleapis.com/v1/speech:recognize", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ config: recognitionConfig, audio: { content: audioBytes } })
    });

    if (!res.ok) {
      const t = await res.text();
      logger.error({ status: res.status, body: t.slice(0, 400) }, "Error Google Speech-to-Text");
      return null;
    }
    const json = await res.json();
    const text = (json.results || [])
      .map(r => r.alternatives?.[0]?.transcript || "")
      .join(" ")
      .trim();
    return text || null;
  } catch (err) {
    logger.error({ err: err.message }, "Excepción transcribiendo audio (Google)");
    return null;
  }
}
