// ═══════════════════════════════════════════════════════════════
// ÁLBUM DEL CATÁLOGO — las láminas de pelucas que Winny le manda a
// las clientas para que escojan.
//
// Son collages (varias pelucas por foto), SIN precios, y mezclan
// fibra y humano. Por eso el bot NO puede cotizar desde la foto: le
// enseña el álbum, la clienta escoge, y ahí el bot le dice el precio
// del catálogo real y si está disponible.
//
// Winny las carga desde su propio WhatsApp: manda las fotos al bot y
// escribe "album". Así no hay que subir archivos ni desplegar nada.
// ═══════════════════════════════════════════════════════════════
import db from "./db.js";
import { logger } from "./logger.js";

db.exec(`CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);`);

const CLAVE = "album_catalogo";

export function guardar_album(urls) {
  const limpias = (urls || []).filter(u => typeof u === "string" && u.startsWith("http")).slice(0, 10);
  if (!limpias.length) return 0;
  db.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .run(CLAVE, JSON.stringify(limpias));
  logger.info({ laminas: limpias.length }, "📔 Álbum del catálogo guardado");
  return limpias.length;
}

export function obtener_album() {
  try {
    const v = db.prepare("SELECT v FROM settings WHERE k = ?").get(CLAVE)?.v;
    const arr = v ? JSON.parse(v) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function hay_album() {
  return obtener_album().length > 0;
}

export function borrar_album() {
  db.prepare("DELETE FROM settings WHERE k = ?").run(CLAVE);
}
