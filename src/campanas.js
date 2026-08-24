// ═══════════════════════════════════════════════════════════════
// CAMPAÑAS — reactivar clientas con la plantilla aprobada de Meta.
//
// WhatsApp solo deja escribirle libremente a quien te escribió en las
// últimas 24h. Fuera de eso hay que usar una PLANTILLA aprobada. Ya
// tenemos "reactivacion_clientas_v1" aprobada, así que se puede.
//
// Pero se puede ≠ conviene. Si mucha gente reporta o bloquea el número,
// Meta baja la calidad de la línea y termina bloqueándola. Por eso:
//   · por defecto solo a clientas que YA te escribieron alguna vez
//   · un tope diario bajo (50) y con pausas entre mensajes
//   · solo de 9am a 8pm
//   · nunca a quien pidió que no le escriban
//   · nunca dos veces a la misma en la misma campaña
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { send_wa_template } from "./whatsapp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    plantilla_sid TEXT NOT NULL,
    audiencia TEXT NOT NULL,
    por_dia INTEGER NOT NULL DEFAULT 50,
    estado TEXT NOT NULL DEFAULT 'activa',
    creada_por TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS campaign_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    nombre TEXT,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    error TEXT,
    sent_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ct ON campaign_targets(campaign_id, estado);
`);
try { db.exec("ALTER TABLE contacts ADD COLUMN no_promo INTEGER DEFAULT 0"); } catch { /* ya existe */ }

const PLANTILLA_REACTIVACION = process.env.TEMPLATE_REACTIVACION_SID
  || "HX77482000b16acbd78d9d080a9c80e54a"; // reactivacion_clientas_v1 (aprobada)

const DIA = 86400000;
const HORA_DESDE = 9, HORA_HASTA = 20; // horario decente para escribirle a una clienta

// Palabras con las que una clienta pide que no le escriban más.
const NO_ESCRIBIR = /\b(stop|baja|unsubscribe|no me escrib|no escribir|no quiero|quitame|quítame|eliminame|elimíname|sacame|sácame|deja de escribir)\b/i;

function hora_rd() {
  return new Date(Date.now() - 4 * 3600000).getUTCHours();
}
function inicio_dia() {
  const off = 4 * 3600000;
  return Math.floor((Date.now() - off) / 86400000) * 86400000 + off;
}
const dormir = ms => new Promise(r => setTimeout(r, ms));

// ─── Público al que se le puede escribir ─────────────────────────
// tipo: "escribieron" (seguro) | "nunca" (arriesgado) | "todas"
export function audiencia(tipo = "escribieron", dias = 7) {
  const owner = (config.business.owner_phone || "").replace(/\D/g, "");
  const corte = Date.now() - Math.max(0, Number(dias) || 0) * DIA;

  const filas = db.prepare(`
    SELECT c.phone AS phone, c.name AS nombre, c.no_promo AS no_promo,
           (SELECT MAX(m.timestamp) FROM messages m WHERE m.phone = c.phone AND m.direction = 'in') AS last_in
    FROM contacts c
  `).all();

  return filas.filter(r => {
    if (!r.phone || r.phone.startsWith("ig:")) return false;
    if (r.phone.replace(/\D/g, "") === owner) return false;
    if (r.no_promo) return false;
    const escribio = !!r.last_in;
    if (tipo === "escribieron" && !escribio) return false;
    if (tipo === "nunca" && escribio) return false;
    // A las que están escribiendo AHORA no hay que reactivarlas.
    if (escribio && r.last_in > corte) return false;
    return true;
  });
}

export function crear_campana({ nombre, tipo = "escribieron", dias = 7, por_dia = 50, por = null }) {
  const n = (nombre || "").trim().slice(0, 60) || "Reactivación";
  const gente = audiencia(tipo, dias);
  if (!gente.length) throw new Error("No hay clientas que cumplan con eso.");

  const etiqueta = tipo === "escribieron"
    ? `Clientas que ya escribieron y llevan +${dias} días calladas`
    : tipo === "nunca" ? "Contactos que NUNCA han escrito (importados)"
    : `Todas (+${dias} días calladas)`;

  const id = db.prepare(`INSERT INTO campaigns (nombre, plantilla_sid, audiencia, por_dia, estado, creada_por, created_at)
                         VALUES (?, ?, ?, ?, 'activa', ?, ?)`)
    .run(n, PLANTILLA_REACTIVACION, etiqueta, Math.max(1, Math.min(200, Number(por_dia) || 50)), por, Date.now())
    .lastInsertRowid;

  const ins = db.prepare("INSERT INTO campaign_targets (campaign_id, phone, nombre) VALUES (?,?,?)");
  const tx = db.transaction(lista => { for (const g of lista) ins.run(id, g.phone, g.nombre || null); });
  tx(gente);

  logger.info({ id, nombre: n, total: gente.length, tipo }, "📣 Campaña creada");
  return { id, total: gente.length };
}

export function campana_activa() {
  return db.prepare("SELECT * FROM campaigns WHERE estado = 'activa' ORDER BY created_at DESC LIMIT 1").get() || null;
}

export function listar_campanas() {
  return db.prepare("SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 30").all().map(c => ({ ...c, ...conteo(c.id) }));
}

export function conteo(id) {
  const q = (sql, ...a) => db.prepare(sql).get(id, ...a)?.n || 0;
  return {
    total: q("SELECT COUNT(*) AS n FROM campaign_targets WHERE campaign_id = ?"),
    enviados: q("SELECT COUNT(*) AS n FROM campaign_targets WHERE campaign_id = ? AND estado = 'enviado'"),
    pendientes: q("SELECT COUNT(*) AS n FROM campaign_targets WHERE campaign_id = ? AND estado = 'pendiente'"),
    fallidos: q("SELECT COUNT(*) AS n FROM campaign_targets WHERE campaign_id = ? AND estado = 'fallido'"),
    saltados: q("SELECT COUNT(*) AS n FROM campaign_targets WHERE campaign_id = ? AND estado = 'saltado'"),
    hoy: db.prepare(`SELECT COUNT(*) AS n FROM campaign_targets
                     WHERE campaign_id = ? AND estado = 'enviado' AND sent_at >= ?`).get(id, inicio_dia())?.n || 0,
    // Respondieron = escribieron DESPUÉS de que les llegó el mensaje. Eso es lo que importa.
    respondieron: db.prepare(`SELECT COUNT(*) AS n FROM campaign_targets t
      WHERE t.campaign_id = ? AND t.estado = 'enviado' AND EXISTS (
        SELECT 1 FROM messages m WHERE m.phone = t.phone AND m.direction = 'in' AND m.timestamp > t.sent_at)`)
      .get(id)?.n || 0
  };
}

export function cambiar_estado_campana(id, estado) {
  if (!["activa", "pausada", "terminada"].includes(estado)) return;
  // Solo puede haber una activa a la vez.
  if (estado === "activa") db.prepare("UPDATE campaigns SET estado = 'pausada' WHERE estado = 'activa'").run();
  db.prepare("UPDATE campaigns SET estado = ? WHERE id = ?").run(estado, id);
  logger.info({ id, estado }, "📣 Campaña cambió de estado");
}

export function marcar_no_promo(phone) {
  db.prepare("UPDATE contacts SET no_promo = 1 WHERE phone = ?").run(phone);
}

// ¿Esta clienta pidió que no le escriban? (se mira en lo que ELLA escribió)
function pidio_no_escribir(phone) {
  const filas = db.prepare(`SELECT content FROM messages
    WHERE phone = ? AND direction = 'in' AND type = 'text' AND content IS NOT NULL
    ORDER BY timestamp DESC LIMIT 30`).all(phone);
  return filas.some(f => NO_ESCRIBIR.test(f.content));
}

// ─── El envío, poquito a poquito ─────────────────────────────────
async function vuelta() {
  const c = campana_activa();
  if (!c) return;

  // El aviso de cómo va se manda al cerrar el día, fuera del horario de envío.
  try { await revisar_reporte(c); } catch (e) { logger.error({ err: e.message }, "Campañas: fallo el reporte"); }

  const h = hora_rd();
  if (h < HORA_DESDE || h >= HORA_HASTA) return;

  const n = conteo(c.id);
  if (!n.pendientes) {
    cambiar_estado_campana(c.id, "terminada");
    await avisar_final(c);
    return;
  }

  const cupo = Math.max(0, c.por_dia - n.hoy);
  if (!cupo) return;

  const lote = db.prepare(`SELECT * FROM campaign_targets
    WHERE campaign_id = ? AND estado = 'pendiente' ORDER BY id ASC LIMIT ?`)
    .all(c.id, Math.min(cupo, 10));

  for (const t of lote) {
    // Volver a chequear en cada envío: la campaña se puede pausar a mitad.
    if (!campana_activa() || campana_activa().id !== c.id) return;

    if (pidio_no_escribir(t.phone)) {
      marcar_no_promo(t.phone);
      db.prepare("UPDATE campaign_targets SET estado = 'saltado', error = 'pidió no recibir' WHERE id = ?").run(t.id);
      continue;
    }
    const reciente = db.prepare(`SELECT MAX(timestamp) AS t FROM messages
      WHERE phone = ? AND direction = 'in'`).get(t.phone)?.t || 0;
    if (Date.now() - reciente < DIA) {
      db.prepare("UPDATE campaign_targets SET estado = 'saltado', error = 'ya está escribiendo' WHERE id = ?").run(t.id);
      continue;
    }

    try {
      const primer_nombre = (t.nombre || "").trim().split(/\s+/)[0].replace(/[^\p{L}\s]/gu, "").slice(0, 20);
      const sid = await send_wa_template(t.phone, c.plantilla_sid, { "1": primer_nombre || "reina" });
      if (sid) {
        db.prepare("UPDATE campaign_targets SET estado = 'enviado', sent_at = ? WHERE id = ?").run(Date.now(), t.id);
        db.prepare(`INSERT INTO messages (phone, direction, type, content, wa_message_id, timestamp, source, agent)
                    VALUES (?, 'out', 'text', ?, ?, ?, 'campana', ?)`)
          .run(t.phone, `[Campaña: ${c.nombre}]`, sid, Date.now(), c.nombre);
      } else {
        db.prepare("UPDATE campaign_targets SET estado = 'fallido', error = 'WhatsApp rechazó el envío' WHERE id = ?").run(t.id);
      }
    } catch (e) {
      db.prepare("UPDATE campaign_targets SET estado = 'fallido', error = ? WHERE id = ?").run(e.message.slice(0, 200), t.id);
    }
    await dormir(12000); // 12s entre mensajes: nada de ráfagas
  }
  const fin = conteo(c.id);
  logger.info({ id: c.id, enviados: fin.enviados, hoy: fin.hoy, pendientes: fin.pendientes }, "📣 Campaña: lote enviado");
}

export function start_campaign_poller() {
  setTimeout(() => {
    vuelta().catch(e => logger.error({ err: e.message }, "Campañas: error en la primera vuelta"));
    setInterval(() => {
      vuelta().catch(e => logger.error({ err: e.message }, "Campañas: error en la vuelta"));
    }, 10 * 60 * 1000);
  }, 3 * 60 * 1000);
  logger.info({ plantilla: PLANTILLA_REACTIVACION }, "📣 Campañas listas");
}

// ─── Mandarle la plantilla a un número para verla ────────────────
// Winny quiere ver EXACTAMENTE cómo le llega el mensaje a la clienta.
export async function enviar_prueba(phone, nombre = "reina") {
  const to = String(phone || config.business.owner_phone).replace(/\D/g, "");
  const sid = await send_wa_template(to, PLANTILLA_REACTIVACION, { "1": nombre });
  logger.info({ to, sid }, "📣 Plantilla de prueba enviada");
  return sid;
}

// ─── Aviso a Winny de cómo va la campaña ─────────────────────────
// Un solo mensaje al cerrar el día (8pm) con lo que importa: cuántas
// respondieron. Y otro cuando la campaña termina del todo.
try { db.exec("ALTER TABLE campaigns ADD COLUMN reporte_at INTEGER DEFAULT 0"); } catch { /* ya existe */ }

async function avisar_como_va(c, final = false) {
  const n = conteo(c.id);
  const tasa = n.enviados ? Math.round((n.respondieron / n.enviados) * 100) : 0;
  const juicio = !n.enviados ? ""
    : tasa >= 15 ? "\n\n🔥 Eso está MUY bueno. De cada 100 que reciben, más de 15 te contestan."
    : tasa >= 7 ? "\n\n💚 Va bien. Es una respuesta normal-buena para este tipo de mensaje."
    : tasa >= 3 ? "\n\n🙂 Va floja pero sirve. Vale la pena seguir."
    : "\n\n⚠️ Está respondiendo muy poca gente. Si sigue así, mejor cambiamos el mensaje.";

  const texto = final
    ? `📣 *Campaña terminada: ${c.nombre}*\n\n` +
      `📤 Enviados: ${n.enviados} de ${n.total}\n` +
      `💬 Te respondieron: *${n.respondieron}* (${tasa}%)\n` +
      `⏭️ Saltadas: ${n.saltados}${n.fallidos ? `\n❌ Fallidas: ${n.fallidos}` : ""}` + juicio
    : `📣 *Cómo va tu campaña "${c.nombre}"*\n\n` +
      `📤 Hoy salieron: ${n.hoy}\n` +
      `📤 En total: ${n.enviados} de ${n.total}\n` +
      `💬 Te han respondido: *${n.respondieron}* (${tasa}%)\n` +
      `⏳ Faltan: ${n.pendientes}` + juicio +
      `\n\nLas que responden caen en tu panel y las atiende el bot 💕`;

  await send_text(config.business.owner_phone, texto);
  db.prepare("UPDATE campaigns SET reporte_at = ? WHERE id = ?").run(Date.now(), c.id);
  logger.info({ id: c.id, enviados: n.enviados, respondieron: n.respondieron, final }, "📣 Reporte de campaña enviado a Winny");
}

// Se llama en cada vuelta, ANTES del horario de envío.
export async function revisar_reporte(c) {
  if (!c) return;
  const hoy = inicio_dia();
  if ((c.reporte_at || 0) >= hoy) return;   // ya se le avisó hoy
  if (hora_rd() < 20) return;               // se avisa al cerrar el día
  if (!conteo(c.id).enviados) return;       // nada que reportar todavía
  await avisar_como_va(c, false);
}

export async function avisar_final(c) {
  try { await avisar_como_va(c, true); } catch (e) {
    logger.error({ err: e.message }, "No pude avisar del fin de la campaña");
  }
}
