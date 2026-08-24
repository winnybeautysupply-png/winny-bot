// ═══════════════════════════════════════════════════════════════
// EQUIPO — cuentas individuales de empleadas + productividad real.
//
// Cada empleada tiene su PROPIO enlace con su propia clave. Eso es lo
// que permite saber quién atendió qué, cuánto tardó en responder y
// cuánto se vendió en sus conversaciones. La jefa las crea, desactiva
// o les cambia la clave desde /panel/equipo.
//
// Nada de esto toca al bot: solo lee/escribe la misma base de datos.
// ═══════════════════════════════════════════════════════════════
import crypto from "crypto";
import db from "./db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    clave TEXT NOT NULL UNIQUE,
    activa INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

// Quién mandó cada mensaje saliente hecho por una persona (nombre de la empleada).
try { db.exec("ALTER TABLE messages ADD COLUMN agent TEXT"); } catch { /* ya existe */ }
// A quién le toca esta clienta.
try { db.exec("ALTER TABLE contacts ADD COLUMN assigned_to TEXT"); } catch { /* ya existe */ }
// Qué puede ver cada empleada. Vacío = solo WhatsApp (bandeja y chat).
// Las que ya existían se quedan como estaban para no quitarles nada de golpe.
try {
  db.exec("ALTER TABLE employees ADD COLUMN permisos TEXT");
  db.exec("UPDATE employees SET permisos = 'caja,apartados' WHERE permisos IS NULL");
} catch { /* ya existe */ }

// Clave legible pero no adivinable: wbs-ana-83f2
function nueva_clave(nombre) {
  const slug = (nombre || "emp").toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 12) || "emp";
  return `wbs-${slug}-${crypto.randomBytes(2).toString("hex")}`;
}

// Permisos que se le pueden dar a una empleada, además del WhatsApp
// (la bandeja y el chat los tiene siempre: para eso está).
export const PERMISOS = [
  { id: "caja", label: "Caja", detalle: "Cobrar y ver el cuadre y las ventas del día" },
  { id: "apartados", label: "Apartados", detalle: "Ver y registrar apartados y abonos" }
];

function limpiar_permisos(v) {
  const lista = Array.isArray(v) ? v : String(v || "").split(",");
  return lista.map(s => s.trim()).filter(s => PERMISOS.some(p => p.id === s)).join(",");
}

export function list_employees(incluir_inactivas = true) {
  return db.prepare(`SELECT id, nombre, clave, activa, created_at, permisos FROM employees
                     ${incluir_inactivas ? "" : "WHERE activa = 1"}
                     ORDER BY activa DESC, nombre ASC`).all();
}

export function create_employee(nombre, permisos = "") {
  const n = (nombre || "").trim().slice(0, 40);
  if (!n) throw new Error("Falta el nombre");
  const clave = nueva_clave(n);
  db.prepare("INSERT INTO employees (nombre, clave, activa, created_at, permisos) VALUES (?, ?, 1, ?, ?)")
    .run(n, clave, Date.now(), limpiar_permisos(permisos));
  return { nombre: n, clave };
}

export function set_permisos(id, permisos) {
  db.prepare("UPDATE employees SET permisos = ? WHERE id = ?").run(limpiar_permisos(permisos), id);
}

export function set_active(id, activa) {
  db.prepare("UPDATE employees SET activa = ? WHERE id = ?").run(activa ? 1 : 0, id);
}

export function regenerate_key(id) {
  const e = db.prepare("SELECT nombre FROM employees WHERE id = ?").get(id);
  if (!e) return null;
  const clave = nueva_clave(e.nombre);
  db.prepare("UPDATE employees SET clave = ? WHERE id = ?").run(clave, id);
  return clave;
}

// Devuelve la empleada ACTIVA dueña de esa clave (o null).
export function find_by_key(clave) {
  if (!clave) return null;
  return db.prepare("SELECT id, nombre, permisos FROM employees WHERE clave = ? AND activa = 1").get(clave) || null;
}

// ─── Productividad ───────────────────────────────────────────────
// Recorre los mensajes del periodo por conversación y mide:
//   · mensajes enviados por cada persona
//   · clientas distintas atendidas
//   · tiempo de respuesta = desde que la clienta escribió (y quedó sin
//     contestar) hasta que esa persona le respondió
export function productividad(desde) {
  const msgs = db.prepare(`
    SELECT phone, direction, timestamp, source, agent
    FROM messages WHERE timestamp >= ?
    ORDER BY phone ASC, timestamp ASC
  `).all(desde);

  const stats = new Map();
  const get = k => {
    if (!stats.has(k)) stats.set(k, { quien: k, mensajes: 0, clientas: new Set(), tiempos: [], ventas: 0, monto: 0 });
    return stats.get(k);
  };

  let phone_actual = null;
  let esperando_desde = null; // primer mensaje entrante sin contestar

  for (const m of msgs) {
    if (m.phone !== phone_actual) { phone_actual = m.phone; esperando_desde = null; }
    if (m.direction === "in") {
      if (esperando_desde === null) esperando_desde = m.timestamp;
      continue;
    }
    const quien = m.source === "humano" ? (m.agent || "Panel")
      : m.source === "campana" ? "📣 Campaña"
      : "🤖 Claude";
    const s = get(quien);
    s.mensajes++;
    s.clientas.add(m.phone);
    if (esperando_desde !== null) s.tiempos.push(m.timestamp - esperando_desde);
    esperando_desde = null;
  }

  // Ventas: se atribuyen a la última persona que le escribió a esa clienta
  // ANTES de que el pedido se marcara pagado. Si nadie humano la tocó, es de Claude.
  const ventas = db.prepare(`
    SELECT o.total AS total,
      (SELECT m.agent FROM messages m
        WHERE m.phone = o.phone AND m.source = 'humano' AND m.timestamp <= o.updated_at
        ORDER BY m.timestamp DESC LIMIT 1) AS agente
    FROM orders o
    WHERE o.updated_at >= ? AND o.status IN ('paid','shipped','delivered')
  `).all(desde);

  for (const v of ventas) {
    const s = get(v.agente || "🤖 Claude");
    s.ventas++;
    s.monto += Number(v.total) || 0;
  }

  return [...stats.values()].map(s => ({
    quien: s.quien,
    mensajes: s.mensajes,
    clientas: s.clientas.size,
    ventas: s.ventas,
    monto: s.monto,
    respuesta_media_min: s.tiempos.length
      ? Math.round(s.tiempos.reduce((a, b) => a + b, 0) / s.tiempos.length / 60000)
      : null
  })).sort((a, b) => b.clientas - a.clientas);
}

// Borra la cuenta (solo se ofrece para empleadas ya desactivadas). El historial
// NO se pierde: los mensajes guardan el nombre, no el id.
export function delete_employee(id) {
  db.prepare("DELETE FROM employees WHERE id = ?").run(id);
}
