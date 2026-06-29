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
