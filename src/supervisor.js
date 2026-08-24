// ═══════════════════════════════════════════════════════════════
// SUPERVISOR DE IA — Claude leyendo las conversaciones en segundo plano.
//
// Cada 5 minutos revisa las conversaciones con actividad nueva y para
// cada una escribe una ficha: qué quiere la clienta, qué producto, qué
// tan probable es que compre, si hace falta una persona y cuál es el
// próximo paso para cerrar. Si detecta que necesita humano y nadie la
// está atendiendo, le AVISA a Winny por WhatsApp con el enlace directo.
//
// Cuidado con el gasto (los créditos ya se acabaron dos veces):
//   · modelo barato (Haiku) con respaldo al modelo del bot
//   · solo conversaciones con actividad nueva, máx. 6 por vuelta
//   · una misma conversación no se re-analiza antes de 30 min
//   · tope diario configurable (SUPERVISOR_MAX_DIA, por defecto 200)
//   · interruptor ON/OFF desde el panel, sin tocar código
// ═══════════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import db from "./db.js";
import { send_text } from "./whatsapp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT
  );
  CREATE TABLE IF NOT EXISTS supervisor_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sup_runs_ts ON supervisor_runs(ts);
`);
try { db.exec("ALTER TABLE contacts ADD COLUMN supervisor_alert_at INTEGER DEFAULT 0"); } catch { /* ya existe */ }

const claude = new Anthropic({ apiKey: config.claude.api_key, timeout: 40000, maxRetries: 1 });

const MODELO_BARATO = process.env.SUPERVISOR_MODEL || "claude-haiku-4-5-20251001";
const MAX_DIA = parseInt(process.env.SUPERVISOR_MAX_DIA || "200", 10);
const INTERVALO = 5 * 60 * 1000;   // cada cuánto revisa
const POR_VUELTA = 6;              // conversaciones por vuelta
const COOLDOWN = 30 * 60 * 1000;   // no re-analizar la misma antes de esto
const VENTANA = 6 * 60 * 60 * 1000; // solo conversaciones movidas en las últimas 6h
const RE_AVISO = 3 * 60 * 60 * 1000; // no repetir aviso de la misma clienta antes de 3h
const AVISOS_POR_HORA = 8;          // techo para no ahogar el WhatsApp de Winny

let modelo_actual = MODELO_BARATO;  // si Haiku no está disponible, cae al del bot
let avisos_recientes = [];          // marcas de tiempo de los avisos enviados

// Última vuelta, para diagnosticar sin entrar a los logs de Render.
let ultimo = { ts: 0, candidatas: 0, analizadas: 0, avisadas: 0, error: null };
export function estado_supervisor() {
  return {
    encendido: supervisor_encendido(),
    modelo: modelo_actual,
    analisis_hoy: analisis_hoy(),
    tope_diario: MAX_DIA,
    ultima_vuelta: ultimo.ts ? new Date(ultimo.ts).toISOString() : null,
    candidatas: ultimo.candidatas,
    analizadas: ultimo.analizadas,
    avisadas: ultimo.avisadas,
    error: ultimo.error
  };
}

// ─── Ajustes (interruptor del panel) ─────────────────────────────
export function get_setting(k, def = null) {
  const row = db.prepare("SELECT v FROM settings WHERE k = ?").get(k);
  return row ? row.v : def;
}
export function set_setting(k, v) {
  db.prepare("INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(k, String(v));
}
export function supervisor_encendido() {
  return get_setting("supervisor", process.env.SUPERVISOR === "off" ? "off" : "on") === "on";
}

function inicio_del_dia() {
  const off = 4 * 3600000; // Santo Domingo, UTC-4 fijo
  return Math.floor((Date.now() - off) / 86400000) * 86400000 + off;
}

export function analisis_hoy() {
  return db.prepare("SELECT COUNT(*) AS n FROM supervisor_runs WHERE ts >= ?").get(inicio_del_dia())?.n || 0;
}

// Hora local de Santo Domingo (0-23) — para no despertar a Winny de madrugada.
function hora_rd() {
  return new Date(Date.now() - 4 * 3600000).getUTCHours();
}

// ─── El análisis en sí ───────────────────────────────────────────
const SISTEMA = `Eres la supervisora de ventas de una tienda de belleza dominicana (pelucas, cabello, closures, frontales y productos de instalación). Lees una conversación de WhatsApp entre la tienda y una clienta y devuelves SOLO un JSON, sin texto alrededor, con estas claves exactas:
- resumen: string, máximo 2 frases, en español, qué quiere la clienta y en qué punto está.
- intencion: uno de "Comprar", "Preguntando precio", "Reclamo", "Seguimiento de pedido", "Solo mirando", "Otro".
- producto: string con el producto concreto que le interesa, o "" si no está claro.
- probabilidad: "Alta", "Media" o "Baja" (que compre).
- necesita_humano: boolean. true SOLO si hay reclamo, molestia, negociación de precio, pedido grande o al por mayor, problema de pago o de envío, algo que el bot claramente no supo contestar, o pide hablar con una persona.
- motivo_humano: string corto explicando el true, o "" si es false.
- sugerencia: string, 1 frase, el próximo paso concreto para cerrar la venta.
- consejo_equipo: string, 1 frase dirigida a quien atiende (ej. "lleva 3 mensajes interesada y todavía no le has ofrecido cerrar" o "el precio le pareció alto: ofrécele la de 24 pulgadas"). "" si no hay nada que corregir.
No inventes datos que no estén en la conversación.`;

async function pedir_json(prompt) {
  const intentar = async modelo => {
    const r = await claude.messages.create({
      model: modelo, max_tokens: 500, temperature: 0,
      system: SISTEMA,
      messages: [{ role: "user", content: prompt }]
    });
    return r.content?.find(b => b.type === "text")?.text?.trim() || "";
  };
  let text;
  try {
    text = await intentar(modelo_actual);
  } catch (e) {
    // Si el modelo barato no está disponible en la cuenta, seguimos con el del bot.
    if (modelo_actual !== config.claude.model) {
      logger.warn({ err: e.message, modelo: modelo_actual }, "Supervisor: modelo no disponible, uso el del bot");
      modelo_actual = config.claude.model;
      text = await intentar(modelo_actual);
    } else { throw e; }
  }
  const m = text.match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : null;
}

// Analiza UNA conversación y guarda la ficha en contacts.panel_ai.
export async function analizar(phone) {
  const msgs = db.prepare(`
    SELECT direction, content FROM messages
    WHERE phone = ? AND type = 'text' AND content IS NOT NULL
    ORDER BY timestamp DESC LIMIT 30
  `).all(phone).reverse();
  if (!msgs.length) return null;

  const convo = msgs.map(m => `${m.direction === "in" ? "CLIENTA" : "TIENDA"}: ${m.content}`).join("\n");
  const compras = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS gastado
    FROM orders WHERE phone = ? AND status IN ('paid','shipped','delivered')
  `).get(phone) || { n: 0, gastado: 0 };
  const historial = compras.n
    ? `${compras.n} compras, RD$${compras.gastado} en total`
    : "sin compras registradas";

  const data = await pedir_json(`HISTORIAL DE COMPRAS: ${historial}\n\nCONVERSACIÓN:\n${convo}\n\nDevuelve el JSON.`);
  if (!data) return null;

  db.prepare("UPDATE contacts SET panel_ai = ?, panel_ai_at = ? WHERE phone = ?")
    .run(JSON.stringify(data), Date.now(), phone);
  db.prepare("INSERT INTO supervisor_runs (ts) VALUES (?)").run(Date.now());
  return data;
}

// ─── Aviso a Winny ───────────────────────────────────────────────
async function avisar(phone, data) {
  const now = Date.now();
  avisos_recientes = avisos_recientes.filter(t => now - t < 3600000);
  if (avisos_recientes.length >= AVISOS_POR_HORA) return false;

  const h = hora_rd();
  if (h < 8 || h >= 22) return false; // de madrugada no

  const c = db.prepare("SELECT name, supervisor_alert_at FROM contacts WHERE phone = ?").get(phone) || {};
  if (now - (c.supervisor_alert_at || 0) < RE_AVISO) return false;

  const ultimo = db.prepare(`SELECT content FROM messages WHERE phone = ? AND direction = 'in' AND type = 'text'
                             ORDER BY timestamp DESC LIMIT 1`).get(phone)?.content || "";
  const key = process.env.ADMIN_KEY || "";
  const link = key
    ? `${config.public_base_url}/panel/chat?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(phone)}`
    : "";

  const texto = `🚨 *El supervisor detectó una clienta que necesita a una persona*

👩 ${c.name || "+" + phone}
🎯 ${data.motivo_humano || "requiere atención humana"}
${ultimo ? `💬 "${ultimo.slice(0, 160)}"` : ""}
${data.sugerencia ? `💡 ${data.sugerencia}` : ""}
${link ? `\n👉 Ábrela aquí: ${link}` : ""}`;

  const sid = await send_text(config.business.owner_phone, texto);
  if (sid) {
    avisos_recientes.push(now);
    db.prepare("UPDATE contacts SET supervisor_alert_at = ? WHERE phone = ?").run(now, phone);
    logger.info({ phone, motivo: data.motivo_humano }, "🚨 Supervisor: aviso enviado a Winny");
    return true;
  }
  return false;
}

// ─── Vuelta del supervisor ───────────────────────────────────────
async function vuelta() {
  ultimo = { ts: Date.now(), candidatas: 0, analizadas: 0, avisadas: 0, error: null };
  if (!supervisor_encendido()) { ultimo.error = "apagado"; return; }
  const hechos = analisis_hoy();
  if (hechos >= MAX_DIA) {
    ultimo.error = "tope diario alcanzado";
    logger.info({ hechos, MAX_DIA }, "Supervisor: tope diario alcanzado, descansando");
    return;
  }

  const now = Date.now();
  const owner = (config.business.owner_phone || "").replace(/\D/g, "");
  const filas = db.prepare(`
    SELECT c.phone AS phone, c.handed_off_until AS handoff, c.panel_ai_at AS ai_at,
           (SELECT MAX(m.timestamp) FROM messages m WHERE m.phone = c.phone AND m.direction = 'in') AS last_in,
           (SELECT MAX(m.timestamp) FROM messages m WHERE m.phone = c.phone AND m.direction = 'out') AS last_out
    FROM contacts c
    WHERE c.last_seen > ?
    ORDER BY c.last_seen DESC
    LIMIT 60
  `).all(now - VENTANA);

  const pendientes = filas
    .filter(r => r.phone && r.phone.replace(/\D/g, "") !== owner)
    .filter(r => (r.last_in || 0) > (r.ai_at || 0))                 // hay algo nuevo que leer
    .filter(r => now - (r.ai_at || 0) > COOLDOWN)                   // no la analizamos hace nada
    .slice(0, Math.min(POR_VUELTA, MAX_DIA - hechos));

  ultimo.candidatas = pendientes.length;
  if (!pendientes.length) return;

  let ok = 0, avisadas = 0;
  for (const r of pendientes) {
    try {
      const data = await analizar(r.phone);
      if (!data) continue;
      ok++;
      const atendida_por_humano = (r.handoff || 0) > now;
      const clienta_esperando = (r.last_in || 0) > (r.last_out || 0);
      if (data.necesita_humano && !atendida_por_humano && clienta_esperando) {
        if (await avisar(r.phone, data)) avisadas++;
      }
    } catch (e) {
      ultimo.error = e.message;
      logger.error({ err: e.message, phone: r.phone }, "Supervisor: fallo analizando");
    }
  }
  ultimo.analizadas = ok;
  ultimo.avisadas = avisadas;
  logger.info({ analizadas: ok, avisadas, hoy: analisis_hoy(), modelo: modelo_actual }, "🕵️ Supervisor: vuelta completada");
}

export function start_supervisor() {
  setTimeout(() => {
    vuelta().catch(e => logger.error({ err: e.message }, "Supervisor: error en la primera vuelta"));
    setInterval(() => {
      vuelta().catch(e => logger.error({ err: e.message }, "Supervisor: error en la vuelta"));
    }, INTERVALO);
  }, 60 * 1000); // esperar 1 min tras arrancar, para no competir con el despliegue
  logger.info({ modelo: MODELO_BARATO, max_dia: MAX_DIA, encendido: supervisor_encendido() }, "🕵️ Supervisor de IA iniciado");
}
