// ═══════════════════════════════════════════════════════════════
// Twilio WhatsApp API — helpers para enviar mensajes y descargar media
//
// Reemplaza la implementación original de Meta Cloud API.
// Mantiene las mismas firmas de funciones para no tocar los handlers.
//
// Auth: Basic con API Key SID (user) + API Key Secret (password),
//       sobre la URL de la cuenta (Account SID).
// Número remitente: whatsapp:+18492489801
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import { config } from "./config.js";
import { logger } from "./logger.js";

const ACCOUNT_SID = config.twilio.account_sid;
const API_KEY_SID = config.twilio.api_key_sid;
const API_KEY_SECRET = config.twilio.api_key_secret;
const FROM = `whatsapp:${config.twilio.whatsapp_number}`; // ej: whatsapp:+18492489801

const MESSAGES_URL = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
const AUTH_HEADER = "Basic " + Buffer.from(`${API_KEY_SID}:${API_KEY_SECRET}`).toString("base64");

// Twilio espera el destinatario como "whatsapp:+1809..."; normalizamos.
function wa(addr) {
  if (!addr) return addr;
  return addr.startsWith("whatsapp:") ? addr : `whatsapp:${addr.startsWith("+") ? addr : "+" + addr}`;
}

// fetch con timeout (AbortController) — evita peticiones colgadas si Twilio va lento.
async function fetch_timeout(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── POST genérico a la API de mensajes de Twilio ────────────────
// Nunca lanza: ante error de red/timeout/HTTP devuelve null (el handler sigue).
async function post_message(params) {
  const body = new URLSearchParams(params);
  try {
    const res = await fetch_timeout(MESSAGES_URL, {
      method: "POST",
      headers: {
        "Authorization": AUTH_HEADER,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error({ err: data, to: params.To, status: res.status }, "Error enviando mensaje (Twilio)");
      return null;
    }
    return data.sid; // SID del mensaje saliente
  } catch (err) {
    logger.error({ err: err.message, to: params.To }, "Fallo de red/timeout enviando mensaje (Twilio)");
    return null;
  }
}

// ─── Enviar mensaje de texto ────────────────────────────────────
export async function send_text(to, body) {
  return post_message({ From: FROM, To: wa(to), Body: body });
}

// ─── Botones interactivos → Twilio los maneja con Content Templates.
//     Para un bot conversacional con IA usamos texto plano: degradamos
//     los botones a una lista numerada dentro del mismo mensaje.
export async function send_buttons(to, body, buttons) {
  const opciones = (buttons || [])
    .slice(0, 3)
    .map((b, i) => `${i + 1}. ${b.title}`)
    .join("\n");
  const texto = opciones ? `${body}\n\n${opciones}` : body;
  return send_text(to, texto);
}

// ─── Lista → mismo enfoque: texto plano numerado ────────────────
export async function send_list(to, body, _button_label, sections) {
  const filas = (sections || [])
    .flatMap(s => s.rows || [])
    .map((r, i) => `${i + 1}. ${r.title}${r.description ? ` — ${r.description}` : ""}`)
    .join("\n");
  const texto = filas ? `${body}\n\n${filas}` : body;
  return send_text(to, texto);
}

// ─── Enviar imagen ──────────────────────────────────────────────
// En Twilio la imagen se manda por MediaUrl (debe ser una URL pública).
// Si nos pasan una URL http(s), la usamos. Si nos pasan una ruta local
// (reenvío de comprobante), no podemos servirla públicamente desde aquí,
// así que mandamos solo el caption como texto y dejamos la nota.
export async function send_image(to, image_url_or_path, caption = "") {
  if (image_url_or_path && image_url_or_path.startsWith("http")) {
    return post_message({ From: FROM, To: wa(to), Body: caption || "", MediaUrl: image_url_or_path });
  }
  // Ruta local: no es pública → mandamos el texto del caption
  logger.warn({ image_url_or_path }, "send_image con ruta local — enviando solo caption (Twilio necesita URL pública)");
  return send_text(to, caption || "(imagen)");
}

// ─── Marcar leído / typing: Twilio no expone estas acciones ─────
//     Las dejamos como no-ops para mantener compatibilidad.
export async function mark_read(_message_id) { /* no-op en Twilio */ }
export async function send_typing(_message_id) { /* no-op en Twilio */ }

// ─── Descargar media entrante (foto de comprobante, etc.) ───────
// En el webhook de Twilio llega MediaUrl0; la descargamos con Basic Auth.
export async function download_media(media_url, save_to) {
  if (!media_url) {
    logger.error("download_media sin URL");
    return null;
  }
  try {
    const res = await fetch_timeout(media_url, { headers: { "Authorization": AUTH_HEADER } }, 25000);
    if (!res.ok) {
      logger.error({ media_url, status: res.status }, "No se pudo descargar el media de Twilio");
      return null;
    }
    const mime = res.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await res.arrayBuffer());

    const dir = path.dirname(save_to);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {
      logger.error({ dir, err: e.message }, "No pude crear carpeta para el media");
      return null;
    }
    fs.writeFileSync(save_to, buffer);

    logger.info({ media_url, save_to, size: buffer.length }, "Media descargado (Twilio)");
    return { path: save_to, mime, size: buffer.length };
  } catch (err) {
    logger.error({ media_url, err: err.message }, "Fallo de red/timeout descargando media (Twilio)");
    return null;
  }
}

// ─── Subir media: en el flujo Meta servía para reenviar el comprobante
//     a Winny. En Twilio no hay subida previa; el reenvío se hace por
//     MediaUrl pública. Devolvemos null para que el handler use el
//     fallback de notificar a Winny por texto (el comprobante queda
//     guardado en el servidor de todas formas).
export async function upload_media(_file_path, _mime_type) {
  return null;
}

// ─── Parsear mensaje entrante desde el webhook form-encoded de Twilio ─
// Twilio manda UN mensaje por webhook (no un batch como Meta).
// `body` es el objeto req.body ya parseado (urlencoded).
export function parse_incoming(body) {
  const from = (body.From || "").replace("whatsapp:", "").replace(/^\+/, "");
  const num_media = parseInt(body.NumMedia || "0", 10);
  const base = {
    id: body.MessageSid,
    from,
    timestamp: Date.now(),
    profile_name: body.ProfileName // Twilio incluye el nombre del contacto
  };

  // Ubicación compartida
  if (body.Latitude && body.Longitude) {
    return { ...base, type: "location", latitude: body.Latitude, longitude: body.Longitude };
  }

  // Media adjunta (imagen de comprobante, audio, etc.)
  if (num_media > 0) {
    const media_url = body.MediaUrl0;
    const mime = body.MediaContentType0 || "";
    let type = "document";
    if (mime.startsWith("image/")) type = "image";
    else if (mime.startsWith("audio/")) type = "audio";
    else if (mime.startsWith("video/")) type = "video";
    return { ...base, type, media_url, mime, caption: body.Body || "" };
  }

  // Texto normal
  return { ...base, type: "text", text: body.Body || "" };
}
