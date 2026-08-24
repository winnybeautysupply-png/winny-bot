// ═══════════════════════════════════════════════════════════════
// INVENTARIO — cuánto queda de cada cosa.
//
// Hasta ahora nadie sabía qué había en el local: el catálogo solo decía
// "disponible sí/no" y había que acordarse. Eso lleva a vender lo que no
// hay y a que el bot ofrezca algo agotado.
//
// La existencia vive aquí (no en la hoja de Google) por dos razones:
//   · entra en el respaldo junto con todo lo demás
//   · se descuenta al instante cuando la cajera cobra, sin depender de
//     que la hoja responda
//
// Cada movimiento queda registrado: qué entró, qué salió y quién lo hizo.
// Un número de existencia sin historia no se puede auditar.
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS inventory (
    codigo TEXT PRIMARY KEY,
    nombre TEXT,
    existencia INTEGER NOT NULL DEFAULT 0,
    minimo INTEGER NOT NULL DEFAULT 2,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS inventory_moves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    codigo TEXT NOT NULL,
    cantidad INTEGER NOT NULL,
    motivo TEXT,
    quien TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_moves ON inventory_moves(codigo, ts);
`);

export function get_stock(codigo) {
  const r = db.prepare("SELECT * FROM inventory WHERE codigo = ?").get(String(codigo || ""));
  return r || null;
}

export function existencia(codigo) {
  return get_stock(codigo)?.existencia ?? null; // null = nunca se ha contado
}

// Mapa {codigo: fila} para no consultar producto por producto.
export function todo_el_stock() {
  const m = new Map();
  for (const r of db.prepare("SELECT * FROM inventory").all()) m.set(r.codigo, r);
  return m;
}

// Suma o resta existencia y deja el rastro. cantidad negativa = salida.
export function mover(codigo, cantidad, { motivo = null, quien = null, nombre = null } = {}) {
  const cod = String(codigo || "").trim();
  const n = parseInt(cantidad, 10);
  if (!cod || !Number.isFinite(n) || n === 0) return null;

  const actual = get_stock(cod);
  const nueva = Math.max(0, (actual?.existencia || 0) + n);
  const now = Date.now();

  if (actual) {
    db.prepare("UPDATE inventory SET existencia = ?, nombre = COALESCE(?, nombre), updated_at = ? WHERE codigo = ?")
      .run(nueva, nombre, now, cod);
  } else {
    db.prepare("INSERT INTO inventory (codigo, nombre, existencia, minimo, updated_at) VALUES (?,?,?,2,?)")
      .run(cod, nombre, nueva, now);
  }
  db.prepare("INSERT INTO inventory_moves (codigo, cantidad, motivo, quien, ts) VALUES (?,?,?,?,?)")
    .run(cod, n, motivo, quien, now);
  logger.info({ codigo: cod, cantidad: n, quedan: nueva, motivo, quien }, "📦 Movimiento de inventario");
  return nueva;
}

// Poner la existencia EXACTA (cuando cuenta lo que hay en el local).
export function ajustar(codigo, cantidad, { quien = null, nombre = null } = {}) {
  const cod = String(codigo || "").trim();
  const n = Math.max(0, parseInt(cantidad, 10) || 0);
  if (!cod) return null;
  const actual = get_stock(cod)?.existencia || 0;
  const diferencia = n - actual;
  if (diferencia === 0) {
    db.prepare(`INSERT INTO inventory (codigo, nombre, existencia, minimo, updated_at) VALUES (?,?,?,2,?)
                ON CONFLICT(codigo) DO UPDATE SET nombre = COALESCE(excluded.nombre, nombre), updated_at = excluded.updated_at`)
      .run(cod, nombre, n, Date.now());
    return n;
  }
  return mover(cod, diferencia, { motivo: "conteo", quien, nombre });
}

export function set_minimo(codigo, minimo) {
  const n = Math.max(0, parseInt(minimo, 10) || 0);
  db.prepare(`INSERT INTO inventory (codigo, existencia, minimo, updated_at) VALUES (?,0,?,?)
              ON CONFLICT(codigo) DO UPDATE SET minimo = excluded.minimo, updated_at = excluded.updated_at`)
    .run(String(codigo || ""), n, Date.now());
}

export function movimientos(codigo, limite = 20) {
  return db.prepare("SELECT * FROM inventory_moves WHERE codigo = ? ORDER BY ts DESC LIMIT ?")
    .all(String(codigo || ""), limite);
}

// Lo que está por acabarse (existencia <= mínimo). Es la lista de qué comprar.
export function por_acabarse() {
  return db.prepare(`SELECT * FROM inventory WHERE existencia <= minimo ORDER BY existencia ASC, nombre ASC`).all();
}

export function resumen_inventario() {
  const r = db.prepare(`SELECT COUNT(*) AS productos, COALESCE(SUM(existencia),0) AS unidades FROM inventory`).get()
    || { productos: 0, unidades: 0 };
  const bajos = por_acabarse();
  return {
    productos: r.productos,
    unidades: r.unidades,
    por_acabarse: bajos.length,
    agotados: bajos.filter(x => x.existencia === 0).length
  };
}

// Lo que el BOT necesita saber: qué está agotado, para no ofrecerlo.
// Devuelve un texto corto que se le inyecta al catálogo.
export function contexto_inventario() {
  const filas = db.prepare(`SELECT codigo, nombre, existencia FROM inventory WHERE existencia <= 0`).all();
  if (!filas.length) return "";
  return filas.map(f => `#${f.codigo} ${f.nombre || ""}`).join(", ");
}

// Dejar un producto "sin contar" otra vez (para deshacer un conteo mal hecho).
// Se borra la existencia pero NO los movimientos: el historial no se toca.
export function olvidar(codigo) {
  db.prepare("DELETE FROM inventory WHERE codigo = ?").run(String(codigo || ""));
  logger.info({ codigo }, "📦 Producto vuelto a 'sin contar'");
}
