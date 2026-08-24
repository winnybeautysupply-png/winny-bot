// ═══════════════════════════════════════════════════════════════
// CAJA / VENTAS EN TIENDA — para la cajera del local.
//
// Nada que ver con los pedidos del bot: esto es la venta de mostrador,
// la que se cobra en el momento. La cajera toca el monto, el tipo de
// pelo y cómo pagó, y ya. Al final del día sale el cuadre: cuánto en
// efectivo, cuánto en tarjeta y cuánto por transferencia.
//
// Una venta NO se borra: si se equivoca se ANULA, y queda el rastro.
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    k TEXT PRIMARY KEY,
    v TEXT
  );

  CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monto REAL NOT NULL,
    categoria TEXT,
    metodo TEXT NOT NULL,
    nota TEXT,
    cajera TEXT,
    anulada INTEGER NOT NULL DEFAULT 0,
    anulada_por TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sales_ts ON sales(ts);
`);

export const METODOS = [
  { id: "efectivo", label: "Efectivo", emoji: "💵" },
  { id: "tarjeta", label: "Tarjeta", emoji: "💳" },
  { id: "transferencia", label: "Transferencia", emoji: "🏦" }
];

const CATEGORIAS_DEFAULT = [
  "Pelucas", "Brasileño", "Peruano", "Piano", "Closure",
  "Frontal", "Semi natural", "Instalación", "Productos", "Otro"
];

export function categorias() {
  try {
    const v = db.prepare("SELECT v FROM settings WHERE k = 'venta_categorias'").get()?.v;
    if (v) {
      const arr = v.split(",").map(s => s.trim()).filter(Boolean);
      if (arr.length) return arr;
    }
  } catch { /* sin settings todavía */ }
  return CATEGORIAS_DEFAULT;
}

export function set_categorias(texto) {
  const limpio = (texto || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 20).join(", ");
  if (!limpio) return;
  db.prepare("INSERT INTO settings (k, v) VALUES ('venta_categorias', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(limpio);
}

export function registrar_venta({ monto, categoria = null, metodo, nota = null, cajera = null }) {
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) throw new Error("Falta el monto de la venta.");
  if (!METODOS.some(x => x.id === metodo)) throw new Error("Falta cómo pagó la clienta.");
  const r = db.prepare(`INSERT INTO sales (monto, categoria, metodo, nota, cajera, ts) VALUES (?,?,?,?,?,?)`)
    .run(m, categoria, metodo, nota, cajera, Date.now());
  logger.info({ id: r.lastInsertRowid, monto: m, metodo, cajera }, "🧾 Venta de mostrador registrada");
  return r.lastInsertRowid;
}

export function anular_venta(id, por = null) {
  db.prepare("UPDATE sales SET anulada = 1, anulada_por = ? WHERE id = ?").run(por, id);
  logger.info({ id, por }, "🧾 Venta anulada");
}

// Inicio del día en Santo Domingo (UTC-4 fijo).
export function inicio_del_dia(offset_dias = 0) {
  const off = 4 * 3600000;
  return (Math.floor((Date.now() - off) / 86400000) - offset_dias) * 86400000 + off;
}

export function ventas_del_dia(desde = inicio_del_dia(), hasta = null) {
  return db.prepare(`SELECT * FROM sales WHERE ts >= ? ${hasta ? "AND ts < ?" : ""} ORDER BY ts DESC`)
    .all(...(hasta ? [desde, hasta] : [desde]));
}

// Cuadre de caja: total y desglose por forma de pago (sin contar las anuladas).
export function cuadre(desde = inicio_del_dia(), hasta = null) {
  const filas = ventas_del_dia(desde, hasta).filter(v => !v.anulada);
  const por_metodo = {};
  for (const m of METODOS) por_metodo[m.id] = { total: 0, cantidad: 0 };
  let total = 0;
  for (const v of filas) {
    total += Number(v.monto) || 0;
    if (por_metodo[v.metodo]) {
      por_metodo[v.metodo].total += Number(v.monto) || 0;
      por_metodo[v.metodo].cantidad++;
    }
  }
  const por_categoria = {};
  for (const v of filas) {
    const c = v.categoria || "Sin categoría";
    por_categoria[c] = (por_categoria[c] || 0) + (Number(v.monto) || 0);
  }
  return { total, cantidad: filas.length, por_metodo, por_categoria };
}

// Borrar del todo una venta YA ANULADA (para limpiar un error de tipeo).
// Las ventas buenas no se borran nunca: se anulan y queda el rastro.
export function borrar_venta_anulada(id) {
  db.prepare("DELETE FROM sales WHERE id = ? AND anulada = 1").run(id);
}
