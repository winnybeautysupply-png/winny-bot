// ═══════════════════════════════════════════════════════════════
// Base de datos SQLite — guarda conversaciones, pedidos, estado de cliente
// ═══════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

// Crea una carpeta si se puede; devuelve true/false SIN lanzar (para no tumbar el arranque).
function ensure_dir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (e) {
    console.error(`⚠️  No pude usar/crear la carpeta "${dir}": ${e.message}`);
    return false;
  }
}

// Estado de la DB, expuesto para /health (diagnóstico remoto sin tocar el servidor).
export const DB_INFO = { path: null, persistent: false, memory: false };

// Resuelve una ruta de DB USABLE. Intenta la configurada (disco persistente /app/data);
// si el disco no está montado o no es escribible, cae a ./data local para que el bot
// NO se caiga. Último recurso: DB en memoria (responde, aunque no persista).
function resolve_db_path() {
  for (const p of [config.db_path, "./data/winny-bot.db"]) {
    if (ensure_dir(path.dirname(p))) {
      DB_INFO.path = p;
      DB_INFO.persistent = p === config.db_path;
      if (p !== config.db_path) console.error(`⚠️  Usando ruta de DB de respaldo: ${p} (revisa el disco persistente)`);
      return p;
    }
  }
  DB_INFO.path = ":memory:";
  DB_INFO.memory = true;
  console.error("⚠️  DB en MEMORIA: el bot responde pero NO persiste. Revisa el disco de Render.");
  return ":memory:";
}

// Carpeta de comprobantes (no crítica para el arranque: si falla, se avisa y sigue)
ensure_dir(config.receipts_dir);

const db = new Database(resolve_db_path());
db.pragma("journal_mode = WAL");

// ─── Esquema ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    phone TEXT PRIMARY KEY,
    name TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    handed_off_until INTEGER DEFAULT 0,
    metadata JSON
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    type TEXT NOT NULL,
    content TEXT,
    media_path TEXT,
    wa_message_id TEXT,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (phone) REFERENCES contacts(phone)
  );
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone, timestamp);

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    items JSON NOT NULL DEFAULT '[]',
    customer_name TEXT,
    delivery_address TEXT,
    payment_method TEXT,
    receipt_path TEXT,
    total REAL,
    notes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (phone) REFERENCES contacts(phone)
  );
  CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone, status);
`);

// Migraciones: columnas de envío en orders (si aún no existen)
for (const col of ["guia_envio TEXT", "empresa_envio TEXT", "provincia TEXT", "ubicacion TEXT"]) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${col}`); } catch { /* la columna ya existe */ }
}

// Registro de comprobantes de pago recibidos — para DETECTAR FRAUDE (referencias repetidas).
db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    referencia TEXT,
    monto TEXT,
    banco TEXT,
    fecha TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_payments_ref ON payments(referencia);

  CREATE TABLE IF NOT EXISTS reviews (
    phone TEXT PRIMARY KEY,
    last_reviewed INTEGER NOT NULL
  );
`);

// AUTO-MEJORA: conversaciones con actividad reciente que NO se han revisado
// desde su último mensaje. Devuelve [{phone, last_msg}]. Excluye a la dueña.
export function get_conversations_to_review(windowMs = 24 * 60 * 60 * 1000, limit = 20) {
  const since = Date.now() - windowMs;
  return db.prepare(`
    SELECT m.phone AS phone, MAX(m.timestamp) AS last_msg
    FROM messages m
    WHERE m.type = 'text'
    GROUP BY m.phone
    HAVING last_msg > ?
       AND last_msg > COALESCE((SELECT r.last_reviewed FROM reviews r WHERE r.phone = m.phone), 0)
    ORDER BY last_msg DESC
    LIMIT ?
  `).all(since, limit);
}

export function mark_reviewed(phone) {
  db.prepare(`
    INSERT INTO reviews (phone, last_reviewed) VALUES (?, ?)
    ON CONFLICT(phone) DO UPDATE SET last_reviewed = excluded.last_reviewed
  `).run(phone, Date.now());
}

// Chequeo vivo de la DB para /health (consulta trivial).
export function db_healthy() {
  try { return db.prepare("SELECT 1 AS ok").get()?.ok === 1; } catch { return false; }
}

// ─── API pública ────────────────────────────────────────────────

export function upsert_contact(phone, name) {
  const now = Date.now();
  const existing = db.prepare("SELECT phone FROM contacts WHERE phone = ?").get(phone);
  if (existing) {
    db.prepare("UPDATE contacts SET last_seen = ?, name = COALESCE(?, name) WHERE phone = ?")
      .run(now, name || null, phone);
  } else {
    db.prepare("INSERT INTO contacts (phone, name, first_seen, last_seen) VALUES (?, ?, ?, ?)")
      .run(phone, name || null, now, now);
  }
}

export function save_message({ phone, direction, type, content, media_path, wa_message_id }) {
  db.prepare(`
    INSERT INTO messages (phone, direction, type, content, media_path, wa_message_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(phone, direction, type, content || null, media_path || null, wa_message_id || null, Date.now());
}

export function get_recent_messages(phone, limit = 10) {
  return db.prepare(`
    SELECT direction, type, content, timestamp
    FROM messages
    WHERE phone = ? AND type = 'text'
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(phone, limit).reverse();
}

export function set_handoff(phone, minutes = 60) {
  const until = Date.now() + minutes * 60 * 1000;
  db.prepare("UPDATE contacts SET handed_off_until = ? WHERE phone = ?").run(until, phone);
}

export function clear_handoff(phone) {
  db.prepare("UPDATE contacts SET handed_off_until = 0 WHERE phone = ?").run(phone);
}

export function is_handed_off(phone) {
  const row = db.prepare("SELECT handed_off_until FROM contacts WHERE phone = ?").get(phone);
  return row && row.handed_off_until > Date.now();
}

// ─── Pedidos ────────────────────────────────────────────────────

export function get_active_order(phone) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE phone = ? AND status IN ('draft', 'awaiting_payment', 'awaiting_address')
    ORDER BY created_at DESC LIMIT 1
  `).get(phone);
}

export function create_order(phone) {
  const now = Date.now();
  const result = db.prepare(`
    INSERT INTO orders (phone, status, created_at, updated_at)
    VALUES (?, 'draft', ?, ?)
  `).run(phone, now, now);
  return result.lastInsertRowid;
}

export function update_order(id, fields) {
  const allowed = ["status", "items", "customer_name", "delivery_address",
                   "payment_method", "receipt_path", "total", "notes", "provincia", "ubicacion"];
  const updates = [];
  const values = [];
  for (const k of allowed) {
    if (fields[k] !== undefined) {
      updates.push(`${k} = ?`);
      values.push(typeof fields[k] === "object" ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (updates.length === 0) return;
  updates.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  db.prepare(`UPDATE orders SET ${updates.join(", ")} WHERE id = ?`).run(...values);
}

export function get_order(id) {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
}

// Historial de COMPRAS de una clienta — para que el bot la reconozca cuando
// vuelve y recuerde qué compró, su estado y su envío (aunque haya pasado tiempo).
export function get_customer_orders(phone, limit = 8) {
  return db.prepare(`
    SELECT items, total, status, guia_envio, empresa_envio, created_at
    FROM orders
    WHERE phone = ? AND status IN ('paid','shipped','awaiting_verification','awaiting_payment')
    ORDER BY created_at DESC LIMIT ?
  `).all(phone, limit);
}

// FRAUDE: busca un comprobante previo con la MISMA referencia (o mismo monto+banco).
// Devuelve {reason, phone, created_at} si es sospechoso, o null.
export function find_duplicate_payment({ referencia = null, monto = null, banco = null } = {}) {
  if (referencia && referencia.replace(/\D/g, "").length >= 4) {
    const r = db.prepare("SELECT phone, created_at FROM payments WHERE referencia = ? ORDER BY created_at DESC LIMIT 1").get(referencia);
    if (r) return { reason: "misma REFERENCIA bancaria ya usada", phone: r.phone, created_at: r.created_at };
  }
  if (monto && banco) {
    const r = db.prepare("SELECT phone, created_at FROM payments WHERE monto = ? AND banco = ? ORDER BY created_at DESC LIMIT 1").get(monto, banco);
    if (r) return { reason: "mismo MONTO y BANCO ya registrados", phone: r.phone, created_at: r.created_at };
  }
  return null;
}

// Registra un comprobante recibido (para futuras comparaciones de fraude).
export function record_payment({ phone, referencia = null, monto = null, banco = null, fecha = null }) {
  db.prepare("INSERT INTO payments (phone, referencia, monto, banco, fecha, created_at) VALUES (?,?,?,?,?,?)")
    .run(phone, referencia, monto, banco, fecha, Date.now());
}

// Marca el pedido de una clienta como ENVIADO y guarda guía + empresa de envío.
// Devuelve el id del pedido actualizado, o null si no había pedido.
export function set_shipping(phone, { guia = null, empresa = null } = {}) {
  const order = db.prepare(`
    SELECT id FROM orders
    WHERE phone = ? AND status IN ('paid','awaiting_verification','awaiting_payment','shipped','draft')
    ORDER BY created_at DESC LIMIT 1
  `).get(phone);
  if (!order) return null;
  db.prepare(`
    UPDATE orders SET status='shipped',
      guia_envio = COALESCE(?, guia_envio),
      empresa_envio = COALESCE(?, empresa_envio),
      updated_at = ?
    WHERE id = ?
  `).run(guia, empresa, Date.now(), order.id);
  return order.id;
}

// Pedido de un cliente esperando que Winny verifique el pago
export function get_pending_verification(phone) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE phone = ? AND status = 'awaiting_verification'
    ORDER BY updated_at DESC LIMIT 1
  `).get(phone);
}

// El comprobante más reciente (de cualquier cliente) esperando verificación
export function get_latest_pending_verification() {
  return db.prepare(`
    SELECT o.*, c.name AS contact_name FROM orders o
    LEFT JOIN contacts c ON c.phone = o.phone
    WHERE o.status = 'awaiting_verification'
    ORDER BY o.updated_at DESC LIMIT 1
  `).get();
}

export default db;
