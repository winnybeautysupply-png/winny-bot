// ═══════════════════════════════════════════════════════════════
// RECORDATORIO DE PEDIDOS PENDIENTES — cada 3h le avisa a Winny de:
//   • Pagos recibidos que faltan CONFIRMAR (awaiting_verification)
//   • Pedidos pagados que faltan ENVIAR (paid)
// Para que NUNCA se le quede una clienta colgada (pagó y nunca recibió).
// Recuerda cada pedido máx. 1 vez cada 8h (no spamea).
// ═══════════════════════════════════════════════════════════════
import { config } from "./config.js";
import { logger } from "./logger.js";
import { get_open_orders } from "./db.js";
import { send_text } from "./whatsapp.js";

function rd(n) { return Number(n || 0).toLocaleString("en-US"); }
function items_text(items) {
  let a = items;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = []; } }
  if (!Array.isArray(a) || !a.length) return "(sin detalle del producto)";
  return a.map(p => `${p.cantidad || 1}× ${p.nombre || "producto"}`).join(", ");
}

const reminded = new Map();               // orderId -> última vez que se recordó
const REMIND_EVERY = 8 * 60 * 60 * 1000;  // no repetir el mismo pedido antes de 8h

async function tick() {
  let rows;
  try { rows = get_open_orders(); } catch (e) { logger.error({ err: e.message }, "pending: no pude leer pedidos"); return; }
  const now = Date.now();
  const pagos = rows.filter(o => o.status === "awaiting_verification"); // pagó, falta confirmar
  const envios = rows.filter(o => o.status === "paid");                 // confirmado, falta enviar
  const candidatos = [...pagos, ...envios];
  const due = candidatos.filter(o => (now - (reminded.get(o.id) || 0)) > REMIND_EVERY);
  if (!due.length) return;

  const linesPago = pagos.filter(o => due.includes(o)).map(o => {
    const h = Math.floor((now - (o.created_at || now)) / 3600000);
    return `⚠️ +${o.phone}${o.customer_name ? ` (${o.customer_name})` : ""} — pagó hace ${h}h, FALTA CONFIRMAR\n   ${items_text(o.items)}${o.total ? ` — RD$${rd(o.total)}` : ""}\n   👉 Responde:  *confirmar +${o.phone}*`;
  });
  const linesEnvio = envios.filter(o => due.includes(o)).map(o => {
    return `📦 +${o.phone}${o.customer_name ? ` (${o.customer_name})` : ""} — pagado, FALTA ENVIAR\n   ${items_text(o.items)}`;
  });

  let msg = "🔔 *Pedidos pendientes* — no dejes a ninguna clienta colgada mi reina 💕";
  if (linesPago.length) msg += `\n\n💰 *Pagos por confirmar (${linesPago.length}):*\n` + linesPago.join("\n\n");
  if (linesEnvio.length) msg += `\n\n📦 *Por enviar (${linesEnvio.length}):*\n` + linesEnvio.join("\n\n");

  await send_text(config.business.owner_phone, msg);
  due.forEach(o => reminded.set(o.id, now));
  logger.info({ pagos: linesPago.length, envios: linesEnvio.length }, "🔔 recordatorio de pendientes enviado a Winny");
}

let _timer = null;
export function start_pending_poller() {
  const ms = 3 * 60 * 60 * 1000; // cada 3 horas
  _timer = setInterval(() => { tick().catch(e => logger.error({ err: e.message }, "Error en pending_poller")); }, ms);
  setTimeout(() => { tick().catch(() => {}); }, 90 * 1000); // primer chequeo ~1.5 min tras arrancar
  logger.info("🔔 Recordatorio de pedidos pendientes ACTIVO (cada 3h)");
}
