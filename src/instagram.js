// ═══════════════════════════════════════════════════════════════
// INSTAGRAM Messaging (Meta directo) — el bot responde los DMs de
// Instagram con el MISMO cerebro (Claude), catálogo y precios que
// WhatsApp. NO usa Twilio: habla directo con la Graph API de Meta.
//
// Se activa solo si están las variables de entorno:
//   IG_TOKEN          → access token de la página/IG (para enviar)
//   IG_VERIFY_TOKEN   → token del webhook (para el paso de verificación)
//   IG_ID             → (opcional) IG-scoped id de NUESTRA cuenta (ignorar self)
// Sin IG_TOKEN, el webhook de verificación sigue funcionando (para
// configurarlo en Meta) pero los mensajes entrantes se ignoran.
// ═══════════════════════════════════════════════════════════════
import { config } from "./config.js";
import { logger } from "./logger.js";
import { generate_response } from "./ai.js";
import { upsert_contact, save_message, get_recent_messages } from "./db.js";
import { find_products, get_offers } from "./catalog.js";

const GRAPH = "https://graph.facebook.com/v21.0";

export function ig_enabled() { return !!config.instagram.token; }

// ─── Verificación del webhook (GET) ─────────────────────────────
// Meta manda hub.mode=subscribe, hub.verify_token y hub.challenge.
export function verify_webhook(query) {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token && token === config.instagram.verify_token) {
    logger.info("✅ Webhook de Instagram verificado");
    return { ok: true, challenge };
  }
  logger.warn({ mode }, "❌ Verificación de webhook de Instagram falló (token no coincide)");
  return { ok: false };
}

// ─── Envío a la Graph API ───────────────────────────────────────
async function ig_send(payload) {
  const url = `${GRAPH}/me/messages?access_token=${encodeURIComponent(config.instagram.token)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { logger.error({ err: data, status: res.status }, "Error enviando a Instagram"); return null; }
    return data.message_id || true;
  } catch (err) {
    logger.error({ err: err.message }, "Fallo de red enviando a Instagram");
    return null;
  }
}

export async function send_ig_text(igsid, text) {
  return ig_send({ recipient: { id: igsid }, message: { text } });
}
export async function send_ig_image(igsid, url) {
  return ig_send({
    recipient: { id: igsid },
    message: { attachment: { type: "image", payload: { url, is_reusable: false } } }
  });
}

// ─── Helpers ────────────────────────────────────────────────────
function fmt_history(rows) {
  return rows.map(r => ({ role: r.direction === "in" ? "user" : "assistant", content: r.content || "" }));
}
function rd(n) { return Number(n || 0).toLocaleString("en-US"); }

async function send_ig_product(igsid, p) {
  const lines = [`🛍️ ${p.nombre}`, `💵 RD$${rd(p.precio_detalle)}`];
  if (p.precio_mayor) lines.push(`📦 Por mayor: RD$${rd(p.precio_mayor)} c/u`);
  if (p.colores) lines.push(`🎨 ${p.colores}`);
  await send_ig_text(igsid, lines.join("\n"));
  const media = (p.media_url && p.media_url.startsWith("http")) ? p.media_url : null;
  if (media) await send_ig_image(igsid, media);
}

// ─── Procesa UN mensaje de texto de una clienta por IG ──────────
async function handle_ig_message(igsid, text, profileName) {
  const key = `ig:${igsid}`; // guardamos las conversaciones de IG con este prefijo
  upsert_contact(key, profileName || null);
  save_message({ phone: key, direction: "in", type: "text", content: text });

  const history = fmt_history(get_recent_messages(key, 16)).slice(0, -1); // sin el mensaje actual
  const ctx = { is_open: true, contact_name: profileName, purchase_history: "" };

  const ai = await generate_response(text, history, ctx);
  logger.info({ igsid, tools: (ai.tool_calls || []).map(t => t.name), preview: (ai.text || "").slice(0, 80) }, "🤖 IG: Claude respondió");

  // En IG v1 manejamos mostrar_producto / mostrar_ofertas (fotos con precio). El resto va por texto.
  try {
    for (const tool of ai.tool_calls || []) {
      if (tool.name === "mostrar_producto") {
        const prods = await find_products(tool.input.descripcion || "", 2);
        for (const p of prods) await send_ig_product(igsid, p);
      } else if (tool.name === "mostrar_ofertas") {
        const offers = await get_offers();
        for (const p of offers.slice(0, 4)) await send_ig_product(igsid, p);
      }
    }
  } catch (e) { logger.error({ err: e.message }, "IG: error ejecutando tools"); }

  if (ai.text) {
    await send_ig_text(igsid, ai.text);
    save_message({ phone: key, direction: "out", type: "text", content: ai.text });
  }
}

// ─── Maneja el payload del webhook (POST) ───────────────────────
export async function handle_ig_event(body) {
  if (!ig_enabled()) { logger.warn("IG no configurado (falta IG_TOKEN) — evento ignorado"); return; }
  if (body.object !== "instagram") return;
  const selfId = config.instagram.ig_id;
  for (const entry of body.entry || []) {
    for (const ev of entry.messaging || []) {
      const igsid = ev.sender?.id;
      if (!igsid) continue;
      if (ev.message?.is_echo) continue;          // ignorar mensajes que enviamos nosotros
      if (selfId && igsid === selfId) continue;   // no respondernos a nosotros mismos
      const text = ev.message?.text;
      if (!text) {
        // v1: solo texto. Si mandan foto/sticker/audio, respondemos genérico y cálido.
        if (ev.message) await send_ig_text(igsid, "¡Hola mi amor! 💕 Cuéntame por texto qué buscas (color, tipo de peluca, largo) y te ayudo enseguida ✨");
        continue;
      }
      await handle_ig_message(igsid, text)
        .catch(e => logger.error({ err: e.message, igsid }, "IG: error manejando mensaje"));
    }
  }
}
