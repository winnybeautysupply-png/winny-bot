// ═══════════════════════════════════════════════════════════════
// LOS DATOS DE CONEXIÓN DE META — guardados donde Winny los pueda
// poner ella misma.
//
// Antes esto vivía sólo en variables de entorno de Render, y Render
// es una herramienta de programador: Winny no tiene por qué pelear
// con eso para encender su propio bot. Ahora los datos se guardan en
// la misma base del bot, se escriben desde el panel, y las variables
// de entorno quedan como respaldo por si alguien ya las puso.
//
// Orden: primero lo que Winny pegó en el panel, y si no hay nada,
// lo que venga del entorno.
// ═══════════════════════════════════════════════════════════════

import db from "./db.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const CLAVES = {
  phone_number_id: "wa_phone_number_id",
  waba_id: "wa_business_account_id",
  token: "wa_cloud_token",
  verify_token: "wa_verify_token"
};

function leer(clave, respaldo) {
  try {
    const v = db.prepare("SELECT v FROM settings WHERE k = ?").get(clave)?.v;
    return (v && v.trim()) ? v.trim() : respaldo;
  } catch {
    return respaldo;
  }
}

export function wa_cfg() {
  return {
    phone_number_id: leer(CLAVES.phone_number_id, config.wa_cloud.phone_number_id),
    waba_id:         leer(CLAVES.waba_id,         config.wa_cloud.waba_id),
    token:           leer(CLAVES.token,           config.wa_cloud.token),
    verify_token:    leer(CLAVES.verify_token,    config.wa_cloud.verify_token),
    graph_version:   config.wa_cloud.graph_version
  };
}

// Guarda sólo lo que venga con contenido: así Winny puede pegar un
// dato hoy y otro mañana sin borrar lo que ya tenía.
export function wa_guardar(vals = {}, quien = "panel") {
  const stmt = db.prepare(
    "INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v"
  );
  const puestos = [];
  for (const [campo, clave] of Object.entries(CLAVES)) {
    const v = (vals[campo] ?? "").toString().trim();
    if (!v) continue;
    stmt.run(clave, v);
    puestos.push(campo);
  }
  if (puestos.length) {
    logger.warn({ quien, campos: puestos }, "🔑 Datos de conexión de Meta actualizados desde el panel");
  }
  return puestos;
}

export function wa_borrar(quien = "panel") {
  const stmt = db.prepare("DELETE FROM settings WHERE k = ?");
  for (const clave of Object.values(CLAVES)) stmt.run(clave);
  logger.warn({ quien }, "🔑 Datos de conexión de Meta borrados desde el panel");
}

// Para mostrar en el panel SIN enseñar el token completo.
function tapar(v) {
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 4) + "•".repeat(Math.min(v.length - 8, 24)) + v.slice(-4);
}

export function wa_estado() {
  const c = wa_cfg();
  return {
    phone_number_id: c.phone_number_id || "",
    waba_id: c.waba_id || "",
    token_tapado: tapar(c.token),
    tiene_token: Boolean(c.token),
    verify_token: c.verify_token || "",
    listo: Boolean(c.phone_number_id && c.token)
  };
}
