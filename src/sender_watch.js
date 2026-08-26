// ═══════════════════════════════════════════════════════════════
// VIGILANTE DEL 2do NÚMERO (829-383-9433)
//
// Ese número lleva desde el 5 de julio de 2026 trancado en Twilio con
// error 410 ("Something went wrong. Please create a support ticket").
// Cuando soporte lo destranque va a pasar a ONLINE — pero nadie va a
// estar mirando ese día.
//
// Esto revisa cada 6 horas. En cuanto lo vea ONLINE:
//   1. le pone el webhook del bot (para que los mensajes lleguen aquí)
//   2. le avisa a Winny por WhatsApp que su número ya está atendiendo
//
// El código multi-número ya existe desde julio, así que con el webhook
// puesto el bot atiende ese número igual que el primero, sin tocar nada.
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { send_text } from "./whatsapp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const NUMERO = process.env.SEGUNDO_NUMERO || "+18293839433";
const INTERVALO = 6 * 3600000;

function auth() {
  const sid = process.env.TWILIO_API_KEY_SID;
  const secret = process.env.TWILIO_API_KEY_SECRET;
  if (!sid || !secret) return null;
  return "Basic " + Buffer.from(`${sid}:${secret}`).toString("base64");
}

async function pedir(url, opciones = {}) {
  const a = auth();
  if (!a) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      ...opciones,
      headers: { Authorization: a, ...(opciones.headers || {}) },
      signal: ctrl.signal
    });
    return await res.json().catch(() => null);
  } catch (e) {
    logger.debug({ err: e.message }, "Vigilante: no pude consultar Twilio");
    return null;
  } finally { clearTimeout(t); }
}

// Nota en la BD para no avisar dos veces de lo mismo.
function ya_avisado() {
  try { return db.prepare("SELECT v FROM settings WHERE k = 'segundo_numero_online'").get()?.v === "si"; }
  catch { return false; }
}
function marcar_avisado() {
  try {
    db.prepare("INSERT INTO settings (k, v) VALUES ('segundo_numero_online','si') ON CONFLICT(k) DO UPDATE SET v='si'").run();
  } catch { /* la tabla settings la crea el panel */ }
}

export async function revisar_segundo_numero() {
  const data = await pedir("https://messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp&PageSize=50");
  const lista = data?.senders || [];
  const s = lista.find(x => (x.sender_id || "").includes(NUMERO.replace(/\D/g, "")));
  if (!s) return null;

  if (s.status !== "ONLINE") {
    logger.info({ numero: NUMERO, estado: s.status }, "📵 2do número: sigue sin activarse");
    return s.status;
  }
  if (ya_avisado()) return "ONLINE";

  // ¡Se destrancó! Ponerle el webhook para que los mensajes lleguen al bot.
  const callback = `${config.public_base_url}/webhook`;
  let webhook_ok = false;
  try {
    const r = await pedir(`https://messaging.twilio.com/v2/Channels/Senders/${s.sid}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhook: { callback_url: callback, callback_method: "POST" } })
    });
    webhook_ok = !!(r && r.sid);
  } catch (e) {
    logger.error({ err: e.message }, "Vigilante: fallo poniendo el webhook");
  }

  await send_text(config.business.owner_phone,
    `🎉 *¡Tu número 829-383-9433 ya está ACTIVO!*\n\n` +
    (webhook_ok
      ? "Ya le puse la conexión al bot: desde ahora ese número atiende solo, igual que el 849-248-9801 💕"
      : "Twilio ya lo activó, pero no pude ponerle la conexión automáticamente. Dime y lo reviso 💕") +
    `\n\nLlevaba trancado desde el 5 de julio.`);

  marcar_avisado();
  logger.info({ numero: NUMERO, webhook_ok }, "🎉 2do número ONLINE — webhook configurado y Winny avisada");
  return "ONLINE";
}

export function start_sender_watch() {
  setTimeout(() => {
    revisar_segundo_numero().catch(e => logger.error({ err: e.message }, "Vigilante: error"));
    setInterval(() => {
      revisar_segundo_numero().catch(e => logger.error({ err: e.message }, "Vigilante: error"));
    }, INTERVALO);
  }, 5 * 60 * 1000);
  logger.info({ numero: NUMERO }, "👁️ Vigilando el 2do número");
}
