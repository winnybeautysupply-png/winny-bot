// ═══════════════════════════════════════════════════════════════
// APARTADOS — clientas que reservan una peluca y la van abonando.
//
// El problema real: el apartado vive en el chat. Winny no sabe cuánto
// dinero tiene apartado, quién le debe, ni a quién se le venció el plazo.
// Aquí queda registrado: producto, total, cada abono, balance y fecha
// límite. Con recordatorio automático antes de que venza.
//
// Cada abono es una fila (no se sobreescribe un número): así siempre se
// puede ver cuánto dio, cuándo y por dónde.
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { send_text } from "./whatsapp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT
  );

  CREATE TABLE IF NOT EXISTS layaways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    producto TEXT NOT NULL,
    codigo TEXT,
    total REAL NOT NULL,
    fecha_limite INTEGER,
    estado TEXT NOT NULL DEFAULT 'activo',
    notas TEXT,
    creado_por TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    aviso_at INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_layaways_phone ON layaways(phone, estado);

  CREATE TABLE IF NOT EXISTS layaway_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    layaway_id INTEGER NOT NULL,
    monto REAL NOT NULL,
    metodo TEXT,
    nota TEXT,
    registrado_por TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_layaway_pay ON layaway_payments(layaway_id);
`);

const DIA = 86400000;

// Plazo por defecto de un apartado nuevo. Se cambia desde el panel.
export function plazo_dias() {
  try {
    const row = db.prepare("SELECT v FROM settings WHERE k = 'apartado_dias'").get();
    const n = parseInt(row?.v || "", 10);
    return Number.isFinite(n) && n > 0 ? n : 15;
  } catch { return 15; }
}

// Teléfonos con apartado activo — para pintar la marca en la bandeja de un solo golpe.
export function phones_con_apartado() {
  const m = new Map();
  for (const a of todos_apartados("activo")) {
    const prev = m.get(a.phone) || { n: 0, vencido: false, balance: 0 };
    m.set(a.phone, { n: prev.n + 1, vencido: prev.vencido || a.vencido, balance: prev.balance + a.balance });
  }
  return m;
}

// Añade a un apartado lo calculado: cuánto lleva abonado, cuánto falta,
// si está vencido y cuántos días le quedan.
function enriquecer(a) {
  if (!a) return null;
  const abonado = db.prepare("SELECT COALESCE(SUM(monto), 0) AS s FROM layaway_payments WHERE layaway_id = ?")
    .get(a.id)?.s || 0;
  const balance = Math.max(0, (Number(a.total) || 0) - abonado);
  const dias = a.fecha_limite ? Math.ceil((a.fecha_limite - Date.now()) / DIA) : null;
  return {
    ...a,
    abonado,
    balance,
    dias_restantes: dias,
    vencido: a.estado === "activo" && dias !== null && dias < 0,
    por_vencer: a.estado === "activo" && dias !== null && dias >= 0 && dias <= 3,
    pagado_completo: balance <= 0
  };
}

export function get_apartado(id) {
  return enriquecer(db.prepare("SELECT * FROM layaways WHERE id = ?").get(id));
}

export function apartados_de(phone) {
  return db.prepare("SELECT * FROM layaways WHERE phone = ? ORDER BY created_at DESC").all(phone).map(enriquecer);
}

// Apartados activos de una clienta (lo que el bot necesita saber).
export function apartados_activos_de(phone) {
  return db.prepare("SELECT * FROM layaways WHERE phone = ? AND estado = 'activo' ORDER BY created_at DESC")
    .all(phone).map(enriquecer);
}

export function todos_apartados(estado = "activo") {
  const rows = estado === "todos"
    ? db.prepare(`SELECT l.*, c.name AS nombre FROM layaways l LEFT JOIN contacts c ON c.phone = l.phone
                  ORDER BY l.created_at DESC LIMIT 300`).all()
    : db.prepare(`SELECT l.*, c.name AS nombre FROM layaways l LEFT JOIN contacts c ON c.phone = l.phone
                  WHERE l.estado = ? ORDER BY l.fecha_limite ASC LIMIT 300`).all(estado);
  return rows.map(enriquecer);
}

export function pagos_de(id) {
  return db.prepare("SELECT * FROM layaway_payments WHERE layaway_id = ? ORDER BY ts ASC").all(id);
}

export function crear_apartado({ phone, producto, codigo = null, total, abono = 0, dias = null, notas = null, por = null }) {
  const t = Number(total);
  if (!phone || !producto || !Number.isFinite(t) || t <= 0) throw new Error("Faltan datos del apartado (producto y precio total).");
  const d = Number.isFinite(Number(dias)) && Number(dias) > 0 ? Number(dias) : plazo_dias();
  const now = Date.now();
  const r = db.prepare(`INSERT INTO layaways (phone, producto, codigo, total, fecha_limite, estado, notas, creado_por, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, 'activo', ?, ?, ?, ?)`)
    .run(phone, producto, codigo, t, now + d * DIA, notas, por, now, now);
  const id = r.lastInsertRowid;
  const a = Number(abono);
  if (Number.isFinite(a) && a > 0) abonar(id, { monto: a, metodo: "inicial", por });
  logger.info({ id, phone, producto, total: t, abono }, "🔖 Apartado creado");
  return id;
}

export function abonar(id, { monto, metodo = null, nota = null, por = null }) {
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) throw new Error("El abono tiene que ser un monto mayor que cero.");
  db.prepare("INSERT INTO layaway_payments (layaway_id, monto, metodo, nota, registrado_por, ts) VALUES (?,?,?,?,?,?)")
    .run(id, m, metodo, nota, por, Date.now());
  db.prepare("UPDATE layaways SET updated_at = ? WHERE id = ?").run(Date.now(), id);
  return get_apartado(id);
}

export function cambiar_estado(id, estado) {
  if (!["activo", "entregado", "cancelado"].includes(estado)) return;
  db.prepare("UPDATE layaways SET estado = ?, updated_at = ? WHERE id = ?").run(estado, Date.now(), id);
}

export function ampliar_plazo(id, dias) {
  const d = Number(dias);
  if (!Number.isFinite(d) || d <= 0) return;
  db.prepare("UPDATE layaways SET fecha_limite = ?, aviso_at = 0, updated_at = ? WHERE id = ?")
    .run(Date.now() + d * DIA, Date.now(), id);
}

export function borrar_apartado(id) {
  db.prepare("DELETE FROM layaway_payments WHERE layaway_id = ?").run(id);
  db.prepare("DELETE FROM layaways WHERE id = ?").run(id);
}

// Números para el dashboard: cuánto dinero hay comprometido en apartados.
export function resumen_apartados() {
  const activos = todos_apartados("activo");
  const suma = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
  return {
    cantidad: activos.length,
    comprometido: suma(activos, a => a.total),
    cobrado: suma(activos, a => a.abonado),
    por_cobrar: suma(activos, a => a.balance),
    vencidos: activos.filter(a => a.vencido).length,
    por_vencer: activos.filter(a => a.por_vencer).length,
    listos: activos.filter(a => a.pagado_completo).length
  };
}

// Texto que se le inyecta al bot para que sepa el estado del apartado de esa
// clienta (así responde "te faltan RD$5,000" sin que nadie se lo diga).
export function contexto_apartado(phone) {
  const act = apartados_activos_de(phone);
  if (!act.length) return "";
  return act.map(a => {
    const fecha = a.fecha_limite
      ? new Date(a.fecha_limite).toLocaleDateString("es-DO", { timeZone: "America/Santo_Domingo", day: "2-digit", month: "long" })
      : "sin fecha";
    if (a.pagado_completo) return `"${a.producto}" — YA ESTÁ PAGADO COMPLETO (RD$${a.total}). Solo falta que lo recoja o coordinar el envío.`;
    const plazo = a.dias_restantes === null ? ""
      : a.vencido ? ` El plazo se venció el ${fecha}.`
      : ` Tiene hasta el ${fecha} (${a.dias_restantes} día(s)).`;
    return `"${a.producto}" — total RD$${a.total}, ya abonó RD$${a.abonado}, le faltan RD$${a.balance}.${plazo}`;
  }).join("\n");
}

// ─── Recordatorios ───────────────────────────────────────────────
// Se avisa 3 días antes de vencer y cuando ya venció, máximo 1 vez al día.
// OJO con WhatsApp: solo se le puede escribir libremente a una clienta que
// escribió en las últimas 24h. Si está fuera de esa ventana, el aviso va
// para Winny (que la contacte ella) en vez de perderse.
async function revisar_vencimientos() {
  const now = Date.now();
  const activos = todos_apartados("activo").filter(a => a.fecha_limite && !a.pagado_completo);
  const urgentes = activos.filter(a =>
    (a.vencido || a.por_vencer) && now - (a.aviso_at || 0) > DIA
  );
  if (!urgentes.length) return;

  for (const a of urgentes) {
    try {
      const ultimo_in = db.prepare("SELECT MAX(timestamp) AS t FROM messages WHERE phone = ? AND direction = 'in'")
        .get(a.phone)?.t || 0;
      const en_ventana = now - ultimo_in < 24 * 3600000;
      const fecha = new Date(a.fecha_limite).toLocaleDateString("es-DO",
        { timeZone: "America/Santo_Domingo", day: "2-digit", month: "long" });

      if (en_ventana) {
        const txt = a.vencido
          ? `Hola mi amor 💕 Te recuerdo tu apartado de *${a.producto}*. Se te venció el plazo el ${fecha} y te faltan *RD$${a.balance}*. Dime si quieres que te lo extienda unos días 💕`
          : `Hola mi amor 💕 Tu *${a.producto}* sigue apartada para ti. Te faltan *RD$${a.balance}* y tienes hasta el ${fecha}. ¿Te lo dejo listo? ✨`;
        const sid = await send_text(a.phone, txt);
        if (sid) {
          db.prepare(`INSERT INTO messages (phone, direction, type, content, wa_message_id, timestamp, source)
                      VALUES (?, 'out', 'text', ?, ?, ?, 'humano')`).run(a.phone, txt, sid, now);
          logger.info({ id: a.id, phone: a.phone }, "🔖 Recordatorio de apartado enviado a la clienta");
        }
      } else {
        const nombre = db.prepare("SELECT name FROM contacts WHERE phone = ?").get(a.phone)?.name || `+${a.phone}`;
        await send_text(config.business.owner_phone,
          `🔖 *Apartado ${a.vencido ? "VENCIDO" : "por vencer"}*\n\n` +
          `👩 ${nombre}\n🛍️ ${a.producto}\n💰 Le faltan RD$${a.balance} de RD$${a.total}\n📅 ${a.vencido ? "Venció" : "Vence"} el ${fecha}\n\n` +
          `Ella no escribe hace más de 24h, así que WhatsApp no me deja escribirle a mí. Escríbele tú, mi reina 💕`);
        logger.info({ id: a.id, phone: a.phone }, "🔖 Apartado fuera de ventana — avisado a Winny");
      }
      db.prepare("UPDATE layaways SET aviso_at = ? WHERE id = ?").run(now, a.id);
    } catch (e) {
      logger.error({ err: e.message, id: a.id }, "Error avisando de un apartado");
    }
  }
}

export function start_layaway_poller() {
  setTimeout(() => {
    revisar_vencimientos().catch(e => logger.error({ err: e.message }, "Apartados: error en la primera revisión"));
    setInterval(() => {
      revisar_vencimientos().catch(e => logger.error({ err: e.message }, "Apartados: error revisando"));
    }, 3 * 3600000); // cada 3 horas
  }, 2 * 60 * 1000);
  logger.info({ plazo_dias: plazo_dias() }, "🔖 Vigilancia de apartados iniciada");
}
