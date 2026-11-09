// ═══════════════════════════════════════════════════════════════
// WHATSAPP CLOUD API (Meta directo) — el canal OFICIAL.
//
// Este es el camino que Winny escogió para que el bot conteste en su
// número de siempre (el que usa en WhatsApp Business) SIN riesgo de
// que Meta lo bloquee: se conecta por Coexistencia, no imitando a
// WhatsApp Web. Ella sigue escribiendo desde su celular igual que hoy
// y el bot contesta en ese mismo número cuando ella no está.
//
// Expone las MISMAS funciones que whatsapp.js (el canal de Twilio),
// con las mismas firmas, para que sea una pieza de repuesto y los 11
// archivos que ya importan whatsapp.js no tengan que cambiar.
//
// Lo que aquí sí se puede y en Twilio no:
//   · "escribiendo..." de verdad (los tres puntitos)
//   · marcar el mensaje como leído
//   · botones y listas nativas, en vez de texto numerado
//   · mandar una imagen desde el disco (subiéndola), no sólo por URL
// ═══════════════════════════════════════════════════════════════

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { logger } from "./logger.js";

const C = config.wa_cloud;
const GRAPH = `https://graph.facebook.com/${C.graph_version}`;

// El canal está apagado mientras no haya credenciales en el .env.
// Así el bot sigue funcionando por Twilio sin tocar nada.
export function cloud_enabled() {
  return Boolean(C.phone_number_id && C.token);
}

function auth_headers(extra = {}) {
  return { "Authorization": `Bearer ${C.token}`, ...extra };
}

// Meta quiere el número en formato internacional SIN "+" ni "whatsapp:".
function num(to) {
  return String(to || "").replace("whatsapp:", "").replace(/[^\d]/g, "");
}

// Los ids de media de Meta son numéricos y largos; una ruta de disco no lo es.
export function es_media_id(v) {
  return typeof v === "string" && /^\d{6,}$/.test(v);
}

async function fetch_timeout(url, options = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ─── POST al endpoint de mensajes ───────────────────────────────
async function post_message(payload) {
  if (!cloud_enabled()) {
    logger.warn("WhatsApp Cloud API sin credenciales — mensaje no enviado");
    return null;
  }
  const url = `${GRAPH}/${C.phone_number_id}/messages`;
  try {
    const res = await fetch_timeout(url, {
      method: "POST",
      headers: auth_headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error({ err: data?.error || data, to: payload.to, status: res.status },
        "Error enviando mensaje (Cloud API)");
      return null;
    }
    return data?.messages?.[0]?.id || null; // wamid del mensaje saliente
  } catch (err) {
    logger.error({ err: err.message, to: payload.to }, "Fallo de red/timeout enviando mensaje (Cloud API)");
    return null;
  }
}

// ─── Texto ──────────────────────────────────────────────────────
export async function send_text(to, body) {
  return post_message({
    to: num(to),
    type: "text",
    // preview_url en false: que no se expanda la tarjeta de un enlace.
    text: { body: String(body ?? ""), preview_url: false }
  });
}

// ─── Plantilla aprobada (fuera de la ventana de 24h) ────────────
// En Cloud API la plantilla se identifica por nombre + idioma, no por
// un Content SID como en Twilio. `variables` = {"1":"valor", ...} y se
// mandan en orden como parámetros del cuerpo.
export async function send_wa_template(to, template_name, variables = {}) {
  const params = Object.keys(variables)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => ({ type: "text", text: String(variables[k]) }));
  return post_message({
    to: num(to),
    type: "template",
    template: {
      name: template_name,
      language: { code: "es" },
      ...(params.length ? { components: [{ type: "body", parameters: params }] } : {})
    }
  });
}

// ─── Botones nativos (hasta 3, como manda Meta) ─────────────────
export async function send_buttons(to, body, buttons) {
  const list = (buttons || []).slice(0, 3);
  if (!list.length) return send_text(to, body);
  return post_message({
    to: num(to),
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: String(body ?? "").slice(0, 1024) },
      action: {
        buttons: list.map((b, i) => ({
          type: "reply",
          reply: { id: b.id || `btn_${i + 1}`, title: String(b.title).slice(0, 20) }
        }))
      }
    }
  });
}

// ─── Lista nativa ───────────────────────────────────────────────
export async function send_list(to, body, button_label, sections) {
  const secs = (sections || [])
    .map(s => ({
      title: String(s.title || "Opciones").slice(0, 24),
      rows: (s.rows || []).slice(0, 10).map((r, i) => ({
        id: r.id || `row_${i + 1}`,
        title: String(r.title).slice(0, 24),
        ...(r.description ? { description: String(r.description).slice(0, 72) } : {})
      }))
    }))
    .filter(s => s.rows.length);
  if (!secs.length) return send_text(to, body);
  return post_message({
    to: num(to),
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: String(body ?? "").slice(0, 1024) },
      action: { button: String(button_label || "Ver opciones").slice(0, 20), sections: secs }
    }
  });
}

// ─── Imagen ─────────────────────────────────────────────────────
// Si es URL pública se manda por link. Si es una ruta local (reenviar
// el comprobante que mandó la clienta), se sube primero a Meta y se
// manda por id — esto en Twilio no se podía.
export async function send_image(to, image_url_or_path, caption = "") {
  if (image_url_or_path && /^https?:\/\//.test(image_url_or_path)) {
    return post_message({
      to: num(to), type: "image",
      image: { link: image_url_or_path, ...(caption ? { caption } : {}) }
    });
  }
  // Un id de media que ya está en los servidores de Meta (la foto que acaba
  // de mandar la clienta). Se reenvía por id: ni se baja ni se vuelve a subir.
  if (es_media_id(image_url_or_path)) {
    return post_message({
      to: num(to), type: "image",
      image: { id: String(image_url_or_path), ...(caption ? { caption } : {}) }
    });
  }
  const media_id = await upload_media(image_url_or_path, "image/jpeg");
  if (!media_id) {
    logger.warn({ image_url_or_path }, "No se pudo subir la imagen — se manda sólo el texto");
    return send_text(to, caption || "(imagen)");
  }
  return post_message({
    to: num(to), type: "image",
    image: { id: media_id, ...(caption ? { caption } : {}) }
  });
}

// ─── Marcar como leído ──────────────────────────────────────────
export async function mark_read(message_id) {
  if (!message_id) return null;
  return post_message({ status: "read", message_id });
}

// ─── "escribiendo..." (los tres puntitos) ───────────────────────
// Meta lo manda junto con el "leído", sobre un mensaje ENTRANTE.
// Dura hasta 25 segundos o hasta que se envíe la respuesta, lo que
// pase primero — por eso encaja con la espera de 5 a 20 segundos de
// las reglas anti-bloqueo.
export async function send_typing(message_id) {
  if (!message_id) return null;
  return post_message({
    status: "read",
    message_id,
    typing_indicator: { type: "text" }
  });
}

// ─── Subir un archivo a Meta y quedarse con su id ───────────────
export async function upload_media(file_path, mime_type = "application/octet-stream") {
  if (!cloud_enabled() || !file_path || !fs.existsSync(file_path)) return null;
  try {
    const buf = fs.readFileSync(file_path);
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mime_type);
    form.append("file", new Blob([buf], { type: mime_type }), path.basename(file_path));
    const res = await fetch_timeout(`${GRAPH}/${C.phone_number_id}/media`, {
      method: "POST", headers: auth_headers(), body: form
    }, 60000);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error({ err: data?.error || data }, "Error subiendo media (Cloud API)");
      return null;
    }
    return data.id || null;
  } catch (err) {
    logger.error({ err: err.message, file_path }, "Fallo subiendo media (Cloud API)");
    return null;
  }
}

// ─── Bajar lo que mandó la clienta (comprobante, nota de voz) ───
// En Cloud API el webhook trae un id, no una URL: primero se pide la
// URL temporal y después se baja CON el token (si no, da 401).
export async function download_media(media_id, save_to) {
  if (!cloud_enabled() || !media_id) return null;
  try {
    const meta_res = await fetch_timeout(`${GRAPH}/${media_id}`, { headers: auth_headers() });
    const meta = await meta_res.json().catch(() => ({}));
    if (!meta_res.ok || !meta.url) {
      logger.error({ err: meta?.error || meta, media_id }, "No se pudo pedir la URL del media");
      return null;
    }
    const bin_res = await fetch_timeout(meta.url, { headers: auth_headers() }, 60000);
    if (!bin_res.ok) {
      logger.error({ status: bin_res.status, media_id }, "No se pudo bajar el media");
      return null;
    }
    const buf = Buffer.from(await bin_res.arrayBuffer());
    fs.mkdirSync(path.dirname(save_to), { recursive: true });
    fs.writeFileSync(save_to, buf);
    return save_to;
  } catch (err) {
    logger.error({ err: err.message, media_id }, "Fallo bajando media (Cloud API)");
    return null;
  }
}

// ─── Verificación del webhook (GET que manda Meta una sola vez) ──
export function verify_webhook(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token === C.verify_token) return { ok: true, challenge };
  logger.warn({ mode }, "Verificación del webhook de WhatsApp rechazada");
  return { ok: false };
}

// ─── Traducir el webhook de Meta al formato del bot ─────────────
// Meta puede mandar VARIOS mensajes en un mismo request, así que esto
// devuelve un array. Las notificaciones de estado (entregado, leído)
// vienen en value.statuses y se ignoran: no son mensajes.
export function parse_cloud(body) {
  const salida = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      const v = change?.value;
      if (!v?.messages?.length) continue;

      const nuestro_numero = v?.metadata?.display_phone_number || "";
      const perfil = {};
      for (const c of v.contacts || []) {
        if (c?.wa_id) perfil[c.wa_id] = c?.profile?.name || null;
      }

      for (const m of v.messages) {
        const base = {
          id: m.id,
          from: num(m.from),
          to: nuestro_numero,
          timestamp: m.timestamp ? Number(m.timestamp) * 1000 : Date.now(),
          profile_name: perfil[m.from] || null,
          canal: "cloud"
        };

        if (m.type === "location" && m.location) {
          salida.push({ ...base, type: "location",
            latitude: m.location.latitude, longitude: m.location.longitude });
          continue;
        }

        // Respuesta a un botón o a una fila de lista → se trata como
        // texto, que es lo que el cerebro del bot entiende.
        if (m.type === "interactive") {
          const i = m.interactive || {};
          const texto = i.button_reply?.title || i.list_reply?.title || "";
          salida.push({ ...base, type: "text", text: texto });
          continue;
        }
        if (m.type === "button") {
          salida.push({ ...base, type: "text", text: m.button?.text || "" });
          continue;
        }

        const media = m.image || m.audio || m.video || m.document || m.sticker;
        if (media?.id) {
          let type = "document";
          if (m.image || m.sticker) type = "image";
          else if (m.audio) type = "audio";
          else if (m.video) type = "video";
          salida.push({ ...base, type,
            media_id: media.id,
            // messages.js (escrito para Twilio) lee parsed.media_url. En Cloud
            // API no hay URL sino un id, así que se pone el id aquí también:
            // download_media y send_image del canal cloud saben leerlo.
            media_url: media.id,
            mime: media.mime_type || "", caption: media.caption || "" });
          continue;
        }

        salida.push({ ...base, type: "text", text: m.text?.body || "" });
      }
    }
  }
  return salida;
}
