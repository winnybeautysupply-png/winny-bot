// ═══════════════════════════════════════════════════════════════
// COMPRAS — la contabilidad de lo que Winny COMPRA (no de lo que vende).
//
// El problema real: cuando trae mercancía de China, el precio de la
// factura NO es lo que le costó. Encima van el flete, la aduana, el
// agente, el transporte. Si no se suma todo, ella pone precio sobre
// un costo que no existe y cree que está ganando más de lo que gana.
//
// Por eso una compra tiene DOS partes:
//   1. La mercancía        → tabla `purchases`     (puede ser en USD)
//   2. Los gastos de traer → tabla `purchase_costs` (siempre en pesos)
// y el número que importa es la suma de las dos dividida entre las
// piezas: el COSTO REAL POR PIEZA.
//
// Distinto de `expenses` (ventas.js), que son los gastos chiquitos del
// día (luz, almuerzo, taxi). Eso no es mercancía y no lleva costeo.
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha INTEGER NOT NULL,
    proveedor TEXT NOT NULL,
    descripcion TEXT,
    tipo TEXT NOT NULL DEFAULT 'local',      -- 'local' | 'importacion'
    moneda TEXT NOT NULL DEFAULT 'DOP',      -- 'DOP' | 'USD'
    monto REAL NOT NULL,                     -- en la moneda de arriba
    tasa REAL,                               -- pesos por dólar (solo si moneda = USD)
    factura TEXT,
    piezas INTEGER,
    estado TEXT NOT NULL DEFAULT 'pagada',
    nota TEXT,
    quien TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS purchase_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL,
    concepto TEXT NOT NULL,                  -- flete, aduana, agente, transporte...
    monto REAL NOT NULL,                     -- SIEMPRE en pesos
    nota TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_pcosts ON purchase_costs (purchase_id);
  CREATE INDEX IF NOT EXISTS idx_purch_fecha ON purchases (fecha DESC);
`);

// Los estados van en orden: así el panel puede pintar por dónde va cada compra.
export const ESTADOS = [
  { id: "pedida",      nombre: "Pedida",       emoji: "📝" },
  { id: "pagada",      nombre: "Pagada",       emoji: "💵" },
  { id: "en_transito", nombre: "En camino",    emoji: "✈️" },
  { id: "en_aduana",   nombre: "En aduana",    emoji: "🏛️" },
  { id: "recibida",    nombre: "Recibida",     emoji: "✅" }
];

export const CONCEPTOS = ["flete", "aduana", "agente", "transporte", "almacenaje", "otro"];

const num = v => {
  // Winny escribe "3,750.00" o "3750" indistintamente. Quitamos las comas
  // de miles pero respetamos el punto decimal.
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : NaN;
};

function esEstado(e) {
  return ESTADOS.some(x => x.id === e) ? e : "pagada";
}

// ─── Compras ─────────────────────────────────────────────────────

export function registrar_compra({
  proveedor, descripcion = null, tipo = "local", moneda = "DOP",
  monto, tasa = null, factura = null, piezas = null,
  estado = "pagada", nota = null, quien = null, fecha = null
}) {
  const prov = String(proveedor || "").trim();
  if (!prov) throw new Error("Falta el proveedor.");

  const m = num(monto);
  if (!Number.isFinite(m) || m <= 0) throw new Error("Falta el monto de la compra.");

  const mon = moneda === "USD" ? "USD" : "DOP";
  const t = mon === "USD" ? num(tasa) : null;
  if (mon === "USD" && (!Number.isFinite(t) || t <= 0)) {
    throw new Error("Si la compra es en dólares hay que poner a cuánto estaba el dólar.");
  }

  const p = piezas === null || piezas === "" ? null : Math.trunc(num(piezas));
  const ts = fecha ? Number(fecha) : Date.now();

  const info = db.prepare(`
    INSERT INTO purchases (fecha, proveedor, descripcion, tipo, moneda, monto, tasa,
                           factura, piezas, estado, nota, quien, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ts, prov, descripcion || null, tipo === "importacion" ? "importacion" : "local",
         mon, m, t, factura || null, Number.isFinite(p) && p > 0 ? p : null,
         esEstado(estado), nota || null, quien || null, Date.now());

  logger.info({ id: info.lastInsertRowid, prov, mon, m }, "🧾 Compra registrada");
  return info.lastInsertRowid;
}

export function obtener_compra(id) {
  return db.prepare("SELECT * FROM purchases WHERE id = ?").get(id) || null;
}

export function listar_compras({ desde = null, hasta = null, limite = 200 } = {}) {
  const cond = [], args = [];
  if (desde) { cond.push("fecha >= ?"); args.push(desde); }
  if (hasta) { cond.push("fecha <= ?"); args.push(hasta); }
  const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM purchases ${where} ORDER BY fecha DESC, id DESC LIMIT ?`)
    .all(...args, limite);
}

export function cambiar_estado(id, estado) {
  db.prepare("UPDATE purchases SET estado = ? WHERE id = ?").run(esEstado(estado), id);
}

export function borrar_compra(id) {
  db.prepare("DELETE FROM purchase_costs WHERE purchase_id = ?").run(id);
  db.prepare("DELETE FROM purchases WHERE id = ?").run(id);
}

// ─── Gastos de traer la mercancía ────────────────────────────────

export function agregar_costo(purchase_id, { concepto, monto, nota = null }) {
  if (!obtener_compra(purchase_id)) throw new Error("Esa compra no existe.");
  const m = num(monto);
  if (!Number.isFinite(m) || m <= 0) throw new Error("Falta el monto del gasto.");
  const c = String(concepto || "otro").trim().toLowerCase();
  db.prepare(`INSERT INTO purchase_costs (purchase_id, concepto, monto, nota, created_at)
              VALUES (?,?,?,?,?)`)
    .run(purchase_id, c || "otro", m, nota || null, Date.now());
}

export function borrar_costo(id) {
  db.prepare("DELETE FROM purchase_costs WHERE id = ?").run(id);
}

export function costos_de(purchase_id) {
  return db.prepare("SELECT * FROM purchase_costs WHERE purchase_id = ? ORDER BY id")
    .all(purchase_id);
}

// ─── El cálculo que importa ──────────────────────────────────────
// Devuelve lo que REALMENTE costó la compra puesta en la tienda,
// y cuánto salió cada pieza.

export function costeo(compra) {
  if (!compra) return null;
  const mercancia = compra.moneda === "USD" ? compra.monto * (compra.tasa || 0) : compra.monto;
  const extras = costos_de(compra.id);
  const gastos = extras.reduce((s, c) => s + c.monto, 0);
  const total = mercancia + gastos;
  return {
    mercancia_dop: mercancia,
    gastos_dop: gastos,
    total_dop: total,
    por_pieza: compra.piezas > 0 ? total / compra.piezas : null,
    // Cuánto encarece el traerla: útil para saber si el flete se está comiendo el negocio.
    recargo_pct: mercancia > 0 ? (gastos / mercancia) * 100 : 0,
    extras
  };
}

// ─── Resumen para la pantalla principal ──────────────────────────

export function resumen({ desde = null, hasta = null } = {}) {
  const compras = listar_compras({ desde, hasta, limite: 1000 });
  let mercancia = 0, gastos = 0, piezas = 0;
  for (const c of compras) {
    const k = costeo(c);
    mercancia += k.mercancia_dop;
    gastos += k.gastos_dop;
    piezas += c.piezas || 0;
  }
  return {
    cantidad: compras.length,
    mercancia_dop: mercancia,
    gastos_dop: gastos,
    total_dop: mercancia + gastos,
    piezas,
    pendientes: compras.filter(c => c.estado !== "recibida").length
  };
}

// Primer día del mes en curso, hora de Santo Domingo (UTC-4, sin horario de verano).
export function inicioDelMes() {
  const off = 4 * 3600000;
  const d = new Date(Date.now() - off);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) + off;
}
