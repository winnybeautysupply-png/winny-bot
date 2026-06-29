// ═══════════════════════════════════════════════════════════════
// Base de datos SQLite — guarda conversaciones, pedidos, estado de cliente
// ═══════════════════════════════════════════════════════════════
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config.js";

// Asegura que la carpeta exista
const dir = path.dirname(config.db_path);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(config.receipts_dir)) fs.mkdirSync(config.receipts_dir, { recursive: true });

const db = new Database(config.db_path);
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
                   "payment_method", "receipt_path", "total", "notes"];
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
