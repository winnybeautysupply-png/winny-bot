// ═══════════════════════════════════════════════════════════════
// Poller de ESTADOS DE ENVÍO — revisa la hoja de pedidos cada 5 min.
// Cuando un pedido pasa a "En camino" o "Entregado" y no ha sido
// notificado, le manda un WhatsApp a la clienta y marca la columna
// "Notificado" para no repetir.
//
// ⚠️ Estos mensajes pueden salir FUERA de la ventana de 24h de WhatsApp.
// Para eso Meta exige PLANTILLAS "utility" aprobadas (Twilio Content SID):
//   TEMPLATE_EN_CAMINO_SID  y  TEMPLATE_ENTREGADO_SID (env vars).
// Si no están configuradas, se intenta un mensaje de sesión normal
// (solo funciona si la clienta escribió en las últimas 24h).
// ═══════════════════════════════════════════════════════════════
import { config } from "./config.js";
import { logger } from "./logger.js";
import { read_orders, set_notified } from "./sheets.js";
import { send_text, send_wa_template } from "./whatsapp.js";

const CARE_GUIDE =
  "💆‍♀️ *Cuidado de tu pelo:* no duermas con él suelto, usa productos SIN sulfato, " +
  "peina desde las puntas y usa protector térmico con el calor. ¡Así te dura hermoso! ✨";

// Envía la notificación: plantilla si hay SID; si no (o si falla), mensaje de sesión.
async function notify(to, kind, { template = {}, text }) {
  const sid = kind === "en_camino" ? config.wa_templates.en_camino : config.wa_templates.entregado;
  if (sid) {
    const r = await send_wa_template(to, sid, template);
    if (r) return true;
    logger.warn({ to, kind }, "📦 Plantilla falló; intento mensaje de sesión");
  }
  return !!(await send_text(to, text));
}

async function tick() {
  const rows = await read_orders();
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNumber = i + 1;
    const tel = (r[2] || "").toString().replace(/\D/g, "");   // C Teléfono
    if (!tel || tel.length < 10) continue;                    // salta encabezado / filas inválidas
    const estado = (r[9] || "").toString().trim().toLowerCase();   // J Estado (envío)
    const mensajero = (r[10] || "").toString().trim();             // K Mensajero
    const notificado = (r[12] || "").toString().trim().toLowerCase(); // M Notificado

    // ── "En camino" ──
    if (estado.includes("camino") && notificado !== "en_camino" && notificado !== "entregado") {
      const conMens = mensajero ? ` con ${mensajero}` : "";
      const ok = await notify(tel, "en_camino", {
        template: { "1": mensajero || "tu mensajero" },
        text: `🛵 Tu pedido va en camino${conMens}. Se comunicará contigo antes de llegar 💕`
      });
      if (ok) { await set_notified(rowNumber, "en_camino"); logger.info({ tel, mensajero }, "🛵 notificado: en camino"); }
    }
    // ── "Entregado" ──
    else if (estado.includes("entregado") && notificado !== "entregado") {
      const ok = await notify(tel, "entregado", {
        template: {},
        text: `💖 ¡Gracias por tu compra en Winny Beauty Supply! Esperamos que ames tu pelo ✨\n\n${CARE_GUIDE}`
      });
      if (ok) { await set_notified(rowNumber, "entregado"); logger.info({ tel }, "📦 notificado: entregado"); }
    }
  }
}

let _timer = null;
export function start_shipping_poller() {
  if (!config.sheets.enabled) {
    logger.warn("📦 Poller de envíos: Google Sheets no configurado — no arranca");
    return;
  }
  // Corre de forma continua cada 5 minutos.
  _timer = setInterval(() => {
    tick().catch(e => logger.error({ err: e.message }, "Error en poller de envíos"));
  }, 5 * 60 * 1000);
  logger.info("📦 Poller de envíos ACTIVO (revisa la hoja cada 5 minutos)");
}
