// ═══════════════════════════════════════════════════════════════
// RESPALDO — sacar copia de todo lo que el negocio tiene guardado.
//
// Todo (conversaciones, clientas, pedidos, apartados, caja) vive en un
// solo archivo de base de datos en un disco de Render. Si ese disco se
// daña o se borra, se pierde. Esto permite:
//   · bajar una copia COMPLETA cuando quiera (un archivo)
//   · bajar cada cosa en Excel/CSV para revisarla o guardarla
//   · una copia automática al día, guardando las últimas 7
//
// La copia que ella baja y guarda en su celular o su PC es la que de
// verdad protege: queda FUERA del servidor.
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import db from "./db.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const DIA = 86400000;
const COPIAS_QUE_SE_GUARDAN = 7;

function carpeta_respaldos() {
  const dir = path.join(path.dirname(config.db_path || "./data/winny-bot.db"), "respaldos");
  try { fs.mkdirSync(dir, { recursive: true }); return dir; } catch { return null; }
}

// Copia consistente de la base (better-sqlite3 la hace en caliente, sin parar el bot).
export async function copiar_base(destino) {
  await db.backup(destino);
  return destino;
}

export function fecha_archivo(ts = Date.now()) {
  const d = new Date(ts - 4 * 3600000); // Santo Domingo
  const p = n => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ─── Exportar a CSV (se abre en Excel) ───────────────────────────
function csv_campo(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n;]/.test(s) ? `"${s}"` : s;
}

export const TABLAS = {
  clientas: {
    titulo: "Clientas",
    sql: `SELECT phone AS telefono, name AS nombre, tags AS etiquetas, notes AS notas,
                 assigned_to AS asignada_a, datetime(first_seen/1000,'unixepoch','-4 hours') AS primera_vez,
                 datetime(last_seen/1000,'unixepoch','-4 hours') AS ultima_vez, summary AS ficha
          FROM contacts ORDER BY last_seen DESC`
  },
  mensajes: {
    titulo: "Mensajes",
    sql: `SELECT phone AS telefono, direction AS direccion, type AS tipo, content AS mensaje,
                 COALESCE(source,'bot') AS lo_mando, agent AS persona,
                 datetime(timestamp/1000,'unixepoch','-4 hours') AS fecha
          FROM messages ORDER BY timestamp DESC LIMIT 100000`
  },
  pedidos: {
    titulo: "Pedidos",
    sql: `SELECT id, phone AS telefono, customer_name AS cliente, status AS estado, items AS productos,
                 total, delivery_address AS direccion, provincia, empresa_envio, guia_envio,
                 datetime(created_at/1000,'unixepoch','-4 hours') AS creado,
                 datetime(updated_at/1000,'unixepoch','-4 hours') AS actualizado
          FROM orders ORDER BY created_at DESC`
  },
  apartados: {
    titulo: "Apartados",
    sql: `SELECT l.id, l.phone AS telefono, c.name AS cliente, l.producto, l.total,
                 COALESCE((SELECT SUM(p.monto) FROM layaway_payments p WHERE p.layaway_id = l.id),0) AS abonado,
                 l.total - COALESCE((SELECT SUM(p.monto) FROM layaway_payments p WHERE p.layaway_id = l.id),0) AS falta,
                 l.estado, datetime(l.fecha_limite/1000,'unixepoch','-4 hours') AS vence,
                 datetime(l.created_at/1000,'unixepoch','-4 hours') AS creado, l.creado_por, l.notas
          FROM layaways l LEFT JOIN contacts c ON c.phone = l.phone ORDER BY l.created_at DESC`
  },
  abonos: {
    titulo: "Abonos de apartados",
    sql: `SELECT p.layaway_id AS apartado, l.producto, l.phone AS telefono, p.monto, p.metodo,
                 p.registrado_por AS registro, datetime(p.ts/1000,'unixepoch','-4 hours') AS fecha
          FROM layaway_payments p LEFT JOIN layaways l ON l.id = p.layaway_id ORDER BY p.ts DESC`
  },
  caja: {
    titulo: "Ventas de caja",
    sql: `SELECT id, monto, categoria, metodo, cajera, anulada, anulada_por,
                 datetime(ts/1000,'unixepoch','-4 hours') AS fecha
          FROM sales ORDER BY ts DESC`
  },
  // La mercancía ya viene costeada: monto en pesos + flete/aduana + costo por
  // pieza, que es el número con el que se pone precio.
  compras: {
    titulo: "Compras",
    sql: `SELECT p.id, datetime(p.fecha/1000,'unixepoch','-4 hours') AS fecha,
                 p.proveedor, p.descripcion, p.tipo, p.factura, p.estado, p.piezas,
                 p.moneda, p.monto, p.tasa,
                 ROUND(CASE WHEN p.moneda = 'USD' THEN p.monto * COALESCE(p.tasa,0) ELSE p.monto END, 2) AS mercancia_rd,
                 ROUND(COALESCE((SELECT SUM(c.monto) FROM purchase_costs c WHERE c.purchase_id = p.id),0), 2) AS gastos_rd,
                 ROUND(CASE WHEN p.moneda = 'USD' THEN p.monto * COALESCE(p.tasa,0) ELSE p.monto END
                       + COALESCE((SELECT SUM(c.monto) FROM purchase_costs c WHERE c.purchase_id = p.id),0), 2) AS total_rd,
                 CASE WHEN p.piezas > 0 THEN
                   ROUND((CASE WHEN p.moneda = 'USD' THEN p.monto * COALESCE(p.tasa,0) ELSE p.monto END
                          + COALESCE((SELECT SUM(c.monto) FROM purchase_costs c WHERE c.purchase_id = p.id),0)) / p.piezas, 2)
                 END AS costo_por_pieza_rd,
                 p.quien, p.nota
          FROM purchases p ORDER BY p.fecha DESC`
  },
  gastos_compras: {
    titulo: "Flete y aduana",
    sql: `SELECT c.purchase_id AS compra, p.proveedor, c.concepto, c.monto, c.nota,
                 datetime(c.created_at/1000,'unixepoch','-4 hours') AS fecha
          FROM purchase_costs c LEFT JOIN purchases p ON p.id = c.purchase_id
          ORDER BY c.id DESC`
  }
};

export function exportar_csv(clave) {
  const t = TABLAS[clave];
  if (!t) return null;
  let filas;
  try { filas = db.prepare(t.sql).all(); } catch (e) {
    logger.error({ err: e.message, tabla: clave }, "Respaldo: fallo exportando");
    return null;
  }
  if (!filas.length) return "﻿(sin datos)\n";
  const cols = Object.keys(filas[0]);
  const lineas = [cols.join(",")];
  for (const f of filas) lineas.push(cols.map(c => csv_campo(f[c])).join(","));
  // BOM al inicio para que Excel abra bien las tildes y las eñes.
  return "﻿" + lineas.join("\n") + "\n";
}

export function conteos() {
  const n = sql => { try { return db.prepare(sql).get()?.n || 0; } catch { return 0; } };
  return {
    clientas: n("SELECT COUNT(*) AS n FROM contacts"),
    mensajes: n("SELECT COUNT(*) AS n FROM messages"),
    pedidos: n("SELECT COUNT(*) AS n FROM orders"),
    apartados: n("SELECT COUNT(*) AS n FROM layaways"),
    caja: n("SELECT COUNT(*) AS n FROM sales")
  };
}

// ─── Copia automática diaria (se guardan las últimas 7) ──────────
export function respaldos_guardados() {
  const dir = carpeta_respaldos();
  if (!dir) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(".db"))
      .map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { archivo: f, bytes: st.size, fecha: st.mtimeMs };
      })
      .sort((a, b) => b.fecha - a.fecha);
  } catch { return []; }
}

async function respaldo_diario() {
  const dir = carpeta_respaldos();
  if (!dir) return;
  const nombre = `winny-${fecha_archivo()}.db`;
  const destino = path.join(dir, nombre);
  if (fs.existsSync(destino)) return; // ya se hizo el de hoy
  try {
    await copiar_base(destino);
    const viejos = respaldos_guardados().slice(COPIAS_QUE_SE_GUARDAN);
    for (const v of viejos) { try { fs.unlinkSync(path.join(dir, v.archivo)); } catch { } }
    logger.info({ archivo: nombre, guardados: respaldos_guardados().length }, "💾 Respaldo diario hecho");
  } catch (e) {
    logger.error({ err: e.message }, "Respaldo diario falló");
  }
}

export function start_backup_poller() {
  setTimeout(() => {
    respaldo_diario().catch(() => { });
    setInterval(() => { respaldo_diario().catch(() => { }); }, 6 * 3600000);
  }, 4 * 60 * 1000);
  logger.info("💾 Respaldo automático activo");
}
