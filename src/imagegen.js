// ═══════════════════════════════════════════════════════════════
// Generación de imágenes de producto con IA (Google Vertex AI - Imagen).
// Solo se usa cuando un producto NO tiene foto real en el catálogo.
// Reusa la MISMA cuenta de servicio de Google (scope cloud-platform),
// igual que Sheets y Speech-to-Text — no requiere API key nueva.
//
// Requiere en el proyecto de Google Cloud:
//   - API "Vertex AI" (aiplatform.googleapis.com) habilitada
//   - Billing habilitado (ya lo está)
//   - La cuenta de servicio con rol "Vertex AI User" (roles/aiplatform.user)
// Si algo falta, devuelve null y el bot sigue (manda solo el texto/precio).
//
// CACHÉ: la imagen se guarda en disco por hash de la descripción; si ya
// existe, se reutiliza y NO se vuelve a generar.
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";
import { config } from "./config.js";
import { logger } from "./logger.js";

let _auth = null;
function get_auth() {
  if (_auth) return _auth;
  if (!config.sheets.service_account_email || !config.sheets.private_key) return null;
  _auth = new google.auth.JWT(
    config.sheets.service_account_email,
    null,
    config.sheets.private_key,
    ["https://www.googleapis.com/auth/cloud-platform"]
  );
  return _auth;
}

export function imagegen_enabled() {
  return !!(config.sheets.service_account_email && config.sheets.private_key && config.gcp.project_id);
}

// Prompt de FOTO DE E-COMMERCE a partir de la descripción del producto.
function build_prompt(desc) {
  return (
    `Professional e-commerce catalog product photograph of a hair wig displayed on a neutral, faceless mannequin head. ` +
    `The wig: ${desc}. ` +
    `Studio lighting, clean pure white seamless background, high resolution, ultra realistic, sharp focus, product centered. ` +
    `Beauty supply catalog style. No text, no logos, no watermark, no brand names, no human face.`
  );
}

function ensure_dir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); return true; }
  catch (e) { logger.error({ dir, err: e.message }, "No pude crear carpeta de imágenes generadas"); return false; }
}

// Clave de caché estable a partir de la descripción normalizada.
function cache_key(description) {
  const norm = (description || "").toLowerCase().replace(/\s+/g, " ").trim();
  return crypto.createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

// Devuelve la URL pública de la imagen para una descripción.
// Si ya existe en caché, la reutiliza; si no, la genera con Imagen.
// Devuelve null si no se pudo generar (el bot sigue sin imagen).
export async function get_or_generate_image(description) {
  if (!imagegen_enabled()) return null;
  const desc = (description || "").trim();
  if (!desc) return null;

  const key = cache_key(desc);
  const filename = `${key}.jpg`;
  const filepath = path.join(config.generated_dir, filename);
  const url = `${config.public_base_url}/generadas/${filename}`;

  // ── CACHÉ: si ya existe, reutilizar (no regenerar) ──
  try { if (fs.existsSync(filepath) && fs.statSync(filepath).size > 0) {
    logger.info({ key }, "🖼️ imagen reutilizada de caché");
    return url;
  } } catch { /* seguir y regenerar */ }

  if (!ensure_dir(config.generated_dir)) return null;
  const auth = get_auth();
  if (!auth) return null;

  try {
    const tr = await auth.getAccessToken();
    const token = tr?.token || tr;
    if (!token) { logger.error("No se obtuvo token de Google para Imagen"); return null; }

    const endpoint =
      `https://${config.gcp.imagen_location}-aiplatform.googleapis.com/v1/projects/` +
      `${config.gcp.project_id}/locations/${config.gcp.imagen_location}/publishers/google/models/` +
      `${config.gcp.imagen_model}:predict`;

    const body = {
      instances: [{ prompt: build_prompt(desc) }],
      parameters: {
        sampleCount: 1,
        aspectRatio: "3:4",
        // maniquí sin rostro = objeto, no persona → evita bloqueos de política
        personGeneration: "dont_allow"
      }
    };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 40000);
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
    } finally { clearTimeout(t); }

    if (!res.ok) {
      const txt = await res.text();
      logger.error({ status: res.status, body: txt.slice(0, 500) }, "Error Vertex AI Imagen");
      return null;
    }
    const json = await res.json();
    const b64 = json.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) {
      logger.error({ preview: JSON.stringify(json).slice(0, 300) }, "Imagen sin bytes en la respuesta");
      return null;
    }
    fs.writeFileSync(filepath, Buffer.from(b64, "base64"));
    logger.info({ key, desc: desc.slice(0, 80) }, "🖼️ imagen generada con IA (Imagen)");
    return url;
  } catch (err) {
    logger.error({ err: err.message }, "Excepción generando imagen con Imagen");
    return null;
  }
}
