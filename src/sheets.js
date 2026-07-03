// ═══════════════════════════════════════════════════════════════
// Google Sheets — guarda cada pedido como una fila en la hoja de Winny
//
// Autenticación con cuenta de servicio (service account). La hoja debe
// estar COMPARTIDA con el email de la cuenta de servicio como Editor.
//
// Variables de entorno necesarias:
//   GOOGLE_SHEET_ID                → ID de la hoja (de la URL)
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   → bot-sheets@...iam.gserviceaccount.com
//   GOOGLE_PRIVATE_KEY             → la private_key del JSON (con \n)
//
// Si no está configurado, todo es no-op (el bot sigue funcionando).
// ═══════════════════════════════════════════════════════════════
import { google } from "googleapis";
import { config } from "./config.js";
import { logger } from "./logger.js";

let _sheets = null;

function get_client() {
  if (_sheets) return _sheets;
  if (!config.sheets.enabled) return null;
  const auth = new google.auth.JWT(
    config.sheets.service_account_email,
    null,
    config.sheets.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  _sheets = google.sheets({ version: "v4", auth });
  return _sheets;
}

// Agrega una fila al final de la hoja.
// `values` = arreglo de celdas en el orden de las columnas.
export async function append_order_row(values) {
  const sheets = get_client();
  if (!sheets) {
    logger.warn("Google Sheets no configurado — el pedido no se guardó en la hoja");
    return false;
  }
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: config.sheets.sheet_id,
      range: "A1", // append busca la primera tabla a partir de aquí
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [values] }
    });
    logger.info("📊 Pedido guardado en Google Sheets");
    return true;
  } catch (err) {
    logger.error({ err: err.message }, "Error guardando pedido en Google Sheets");
    return false;
  }
}

// Rango de la hoja de pedidos (A:M). Columnas:
// A Fecha · B Nombre · C Teléfono · D Producto · E Cantidad · F Color/Largo ·
// G Total · H Estado del pago · I Dirección · J Estado(envío) · K Mensajero ·
// L Fecha actualización · M Notificado
function orders_range() {
  const tab = config.sheets.orders_tab;
  return tab ? `${tab}!A1:M` : "A1:M";
}
function only_digits(s) { return (s || "").toString().replace(/\D/g, ""); }

// Lee todas las filas de pedidos (incluye la fila de encabezado si existe).
export async function read_orders() {
  const sheets = get_client();
  if (!sheets) return [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: config.sheets.sheet_id,
      range: orders_range()
    });
    return res.data.values || [];
  } catch (err) {
    logger.error({ err: err.message }, "Error leyendo pedidos de Sheets");
    return [];
  }
}

// Encuentra el pedido MÁS RECIENTE de un teléfono (el último match, porque se
// agregan al final). Devuelve { rowNumber(1-based), estado, mensajero, producto, notificado } o null.
export async function find_latest_order_by_phone(phone) {
  const rows = await read_orders();
  const p = only_digits(phone);
  if (!p) return null;
  let found = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tel = only_digits(r[2]); // col C
    if (!tel) continue;
    const match = tel === p || tel.endsWith(p.slice(-10)) || p.endsWith(tel.slice(-10));
    if (match) {
      found = {
        rowNumber: i + 1,
        fecha: r[0] || "", producto: r[3] || "",
        estado: (r[9] || "").toString().trim(),      // J
        mensajero: (r[10] || "").toString().trim(),  // K
        notificado: (r[12] || "").toString().trim()  // M
      };
    }
  }
  return found;
}

// Escribe la columna Notificado (M) de una fila.
export async function set_notified(rowNumber, value) {
  const sheets = get_client();
  if (!sheets) return false;
  try {
    const tab = config.sheets.orders_tab;
    const range = (tab ? `${tab}!` : "") + `M${rowNumber}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.sheets.sheet_id,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[value]] }
    });
    return true;
  } catch (err) {
    logger.error({ err: err.message }, "Error marcando Notificado en Sheets");
    return false;
  }
}
