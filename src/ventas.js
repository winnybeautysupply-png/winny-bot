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

// Codigo del producto del catalogo, cuando la venta se hizo escogiendolo:
// eso es lo que permite descontar del inventario.
try { db.exec("ALTER TABLE sales ADD COLUMN codigo TEXT"); } catch { /* ya existe */ }

export function registrar_venta({ monto, categoria = null, metodo, nota = null, cajera = null, codigo = null }) {
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) throw new Error("Falta el monto de la venta.");
  if (!METODOS.some(x => x.id === metodo)) throw new Error("Falta cómo pagó la clienta.");
  const r = db.prepare(`INSERT INTO sales (monto, categoria, metodo, nota, cajera, codigo, ts) VALUES (?,?,?,?,?,?,?)`)
    .run(m, categoria, metodo, nota, cajera, codigo, Date.now());
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

// ═══════════════════════════════════════════════════════════════
// GASTOS Y CIERRE DE CAJA
//
// La caja sola solo cuenta lo que entra. Sin los gastos no hay
// ganancia real, y sin el cierre nadie sabe si el efectivo que hay
// en la gaveta es el que debería haber.
// ═══════════════════════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monto REAL NOT NULL,
    categoria TEXT,
    metodo TEXT,
    nota TEXT,
    quien TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_ts ON expenses(ts);

  CREATE TABLE IF NOT EXISTS cash_closes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dia INTEGER NOT NULL,
    efectivo_contado REAL NOT NULL,
    efectivo_esperado REAL NOT NULL,
    diferencia REAL NOT NULL,
    total_ventas REAL NOT NULL,
    total_gastos REAL NOT NULL,
    detalle TEXT,
    quien TEXT,
    ts INTEGER NOT NULL
  );
`);

export const CATEGORIAS_GASTO = ["Mercancía", "Sueldo", "Alquiler", "Transporte", "Servicios", "Comida", "Otro"];

export function registrar_gasto({ monto, categoria = null, metodo = "efectivo", nota = null, quien = null }) {
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) throw new Error("Falta el monto del gasto.");
  db.prepare("INSERT INTO expenses (monto, categoria, metodo, nota, quien, ts) VALUES (?,?,?,?,?,?)")
    .run(m, categoria, metodo, nota, quien, Date.now());
  logger.info({ monto: m, categoria, quien }, "💸 Gasto registrado");
}

export function borrar_gasto(id) {
  db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
}

export function gastos_del_dia(desde = inicio_del_dia()) {
  return db.prepare("SELECT * FROM expenses WHERE ts >= ? ORDER BY ts DESC").all(desde);
}

export function total_gastos(desde = inicio_del_dia()) {
  return db.prepare("SELECT COALESCE(SUM(monto),0) AS s FROM expenses WHERE ts >= ?").get(desde)?.s || 0;
}

// Lo que DEBERÍA haber en efectivo: lo que entró en efectivo menos lo que se
// pagó en efectivo. Tarjeta y transferencia no tocan la gaveta.
export function efectivo_esperado(desde = inicio_del_dia()) {
  const entra = cuadre(desde).por_metodo.efectivo.total;
  const sale = db.prepare("SELECT COALESCE(SUM(monto),0) AS s FROM expenses WHERE ts >= ? AND metodo = 'efectivo'")
    .get(desde)?.s || 0;
  return entra - sale;
}

export function cierre_de_hoy() {
  return db.prepare("SELECT * FROM cash_closes WHERE dia = ? ORDER BY ts DESC LIMIT 1").get(inicio_del_dia()) || null;
}

export function cerrar_caja({ efectivo_contado, quien = null }) {
  const contado = Number(efectivo_contado);
  if (!Number.isFinite(contado) || contado < 0) throw new Error("Escribe cuánto efectivo contaste.");
  const desde = inicio_del_dia();
  const c = cuadre(desde);
  const esperado = efectivo_esperado(desde);
  const gastos = total_gastos(desde);
  db.prepare(`INSERT INTO cash_closes
    (dia, efectivo_contado, efectivo_esperado, diferencia, total_ventas, total_gastos, detalle, quien, ts)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(desde, contado, esperado, contado - esperado, c.total, gastos,
         JSON.stringify(c.por_metodo), quien, Date.now());
  logger.info({ contado, esperado, diferencia: contado - esperado, quien }, "🔒 Caja cerrada");
  return { contado, esperado, diferencia: contado - esperado, ventas: c.total, gastos };
}

export function cierres_recientes(limite = 14) {
  return db.prepare("SELECT * FROM cash_closes ORDER BY dia DESC LIMIT ?").all(limite);
}
