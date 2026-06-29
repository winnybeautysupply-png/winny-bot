// ═══════════════════════════════════════════════════════════════
// Inicializa la base de datos (crea tablas) — opcional, db.js lo hace
// automáticamente al importarse, pero este script lo fuerza.
// ═══════════════════════════════════════════════════════════════
import db from "../db.js";

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("✅ Tablas creadas:");
tables.forEach(t => console.log(`   - ${t.name}`));

const counts = {
  contacts: db.prepare("SELECT COUNT(*) as n FROM contacts").get().n,
  messages: db.prepare("SELECT COUNT(*) as n FROM messages").get().n,
  orders: db.prepare("SELECT COUNT(*) as n FROM orders").get().n
};
console.log("\n📊 Registros actuales:", counts);
