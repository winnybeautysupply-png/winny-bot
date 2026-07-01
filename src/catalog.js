// ═══════════════════════════════════════════════════════════════
// Catálogo / inventario — lee la hoja "catalogo winny" de Winny.
// El bot lo usa para buscar productos y mandarle a la clienta la
// foto/video (Cloudinary) + precio. Reusa la cuenta de servicio.
//
// Columnas: Código | Nombre | Precio detalle | Precio mayor |
// Cant. para mayor | Precio caja | Unidades por caja | Colores |
// Etiquetas | Oferta | Video/Foto (link) | Disponible
// ═══════════════════════════════════════════════════════════════
import { google } from "googleapis";
import { config } from "./config.js";
import { logger } from "./logger.js";

let _sheets = null;
function client() {
  if (_sheets) return _sheets;
  if (!config.sheets.service_account_email || !config.sheets.private_key) return null;
  const auth = new google.auth.JWT(
    config.sheets.service_account_email,
    null,
    config.sheets.private_key,
    ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  );
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

let _cache = null;
let _cacheTime = 0;
const TTL = 5 * 60 * 1000; // 5 minutos (refresca solo, sin reiniciar el bot)

function num(v) {
  const n = parseInt((v ?? "").toString().replace(/[^\d]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}
function yes(v) { return /s[ií]/i.test((v ?? "").toString().trim()); }

export async function get_catalog() {
  if (_cache && Date.now() - _cacheTime < TTL) return _cache;
  const sheets = client();
  if (!sheets || !config.sheets.catalog_sheet_id) return _cache || [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.catalog_sheet_id,
      range: config.sheets.catalog_tab
    });
    const rows = res.data.values || [];
    const products = rows.slice(1).map(r => ({
      codigo: (r[0] ?? "").toString().trim(),
      nombre: (r[1] ?? "").toString().trim(),
      precio_detalle: num(r[2]),
      precio_mayor: num(r[3]),
      cant_mayor: (r[4] ?? "").toString().trim(),
      precio_caja: num(r[5]),
      unidades_caja: (r[6] ?? "").toString().trim(),
      colores: (r[7] ?? "").toString().trim(),
      etiquetas: (r[8] ?? "").toString().trim(),
      oferta: yes(r[9]),
      media_url: (r[10] ?? "").toString().trim(),
      disponible: yes(r[11])
    })).filter(p => p.nombre);
    _cache = products;
    _cacheTime = Date.now();
    logger.info({ n: products.length }, "📚 Catálogo cargado");
    return products;
  } catch (err) {
    logger.error({ err: err.message }, "Error leyendo catálogo");
    return _cache || [];
  }
}

// Normaliza texto: minúsculas, sin acentos, y quita la 's' final (plural→singular)
// para que "pelucas humanas" haga match con etiquetas "peluca, humana".
function norm(s) {
  return (s || "").toLowerCase()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e").replace(/[íìï]/g, "i")
    .replace(/[óòö]/g, "o").replace(/[úùü]/g, "u").replace(/ñ/g, "n");
}
function stem(w) { return w.replace(/s$/, ""); } // singulariza (aproximado)

// Busca productos por descripción (nombre + etiquetas + colores).
export async function find_products(query, limit = 2) {
  const cat = await get_catalog();
  const words = norm(query).split(/[\s,]+/).filter(w => w.length > 2).map(stem);
  if (!words.length) return [];
  const scored = cat
    .filter(p => p.disponible)
    .map(p => {
      const hay = norm(`${p.nombre} ${p.etiquetas} ${p.colores}`);
      let score = 0;
      for (const w of words) if (hay.includes(w)) score++;
      return { p, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(x => x.p);
}

export async function get_offers() {
  const cat = await get_catalog();
  return cat.filter(p => p.oferta && p.disponible);
}

export async function get_by_code(code) {
  const cat = await get_catalog();
  const c = (code ?? "").toString().trim();
  return cat.find(p => p.codigo === c) || null;
}

// Resumen compacto del catálogo para que Claude conozca el inventario.
export async function catalog_summary() {
  const cat = await get_catalog();
  const avail = cat.filter(p => p.disponible);
  if (!avail.length) return "";
  return avail.map(p =>
    `#${p.codigo} ${p.nombre} — RD$${p.precio_detalle}` +
    (p.colores ? ` (${p.colores})` : "") +
    (p.oferta ? " [OFERTA]" : "")
  ).join("\n");
}
