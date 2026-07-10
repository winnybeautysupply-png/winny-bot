// ═══════════════════════════════════════════════════════════════
// Configuración central — lee variables de entorno y las valida
// ═══════════════════════════════════════════════════════════════
import "dotenv/config";

function require_env(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`❌ Falta variable de entorno: ${name}`);
    console.error(`   Copia .env.example a .env y llena los valores`);
    process.exit(1);
  }
  return v;
}

function optional(name, fallback) {
  return process.env[name] ?? fallback;
}

// Parse cuentas bancarias del formato: BANCO:NUMERO:TITULAR:TIPO|...
function parse_banks(raw) {
  if (!raw) return [];
  return raw.split("|").map(line => {
    const [banco, numero, titular, tipo] = line.split(":");
    return { banco, numero, titular, tipo };
  });
}

export const config = {
  // Twilio WhatsApp API
  twilio: {
    account_sid: require_env("TWILIO_ACCOUNT_SID"),
    api_key_sid: require_env("TWILIO_API_KEY_SID"),
    api_key_secret: require_env("TWILIO_API_KEY_SECRET"),
    whatsapp_number: require_env("TWILIO_WHATSAPP_NUMBER") // ej: +18492489801
  },

  // Claude
  claude: {
    api_key: require_env("ANTHROPIC_API_KEY"),
    model: optional("CLAUDE_MODEL", "claude-sonnet-4-5")
  },

  // Negocio
  business: {
    name: optional("BUSINESS_NAME", "Winny Beauty Supply"),
    owner_phone: require_env("OWNER_PHONE"),
    timezone: optional("TZ", "America/Santo_Domingo"),
    hours_start: parseInt(optional("BUSINESS_HOURS_START", "9"), 10),
    hours_end: parseInt(optional("BUSINESS_HOURS_END", "19"), 10),
    days: optional("BUSINESS_DAYS", "1,2,3,4,5,6").split(",").map(d => parseInt(d, 10)),
    bank_accounts: parse_banks(optional("BANK_ACCOUNTS", ""))
  },

  // Servidor
  port: parseInt(optional("PORT", "3000"), 10),
  log_level: optional("LOG_LEVEL", "info"),

  // URL pública del bot (para servir comprobantes a Winny)
  public_base_url: optional("PUBLIC_BASE_URL", "https://winny-bot.onrender.com"),

  // Google Sheets — donde caen los pedidos automáticamente
  sheets: {
    enabled: !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY),
    sheet_id: optional("GOOGLE_SHEET_ID", ""),
    service_account_email: optional("GOOGLE_SERVICE_ACCOUNT_EMAIL", ""),
    // En Render el salto de línea viene escapado como "\n" literal → lo restauramos
    private_key: optional("GOOGLE_PRIVATE_KEY", "").replace(/\\n/g, "\n"),
    // Catálogo de productos (hoja "catalogo winny", pestaña "Catalogo")
    catalog_sheet_id: optional("GOOGLE_CATALOG_SHEET_ID", "18C-c4FAojysgBVjMLUB-_29qm2W7xsW9fFGVWForRoY"),
    catalog_tab: optional("GOOGLE_CATALOG_TAB", "Catalogo"),
    // Pestaña de la hoja de PEDIDOS (vacío = primera hoja del GOOGLE_SHEET_ID)
    orders_tab: optional("GOOGLE_ORDERS_TAB", ""),
    // Pestaña de LOGS de comandos admin (se crea sola si no existe)
    logs_tab: optional("GOOGLE_LOGS_TAB", "Logs"),
    // Auto-mejora: base de conocimiento y salidas de revisión (se crean solas)
    faq_tab: optional("GOOGLE_FAQ_TAB", "FAQ"),
    review_tab: optional("GOOGLE_REVIEW_TAB", "Revisión"),
    faq_suggest_tab: optional("GOOGLE_FAQ_SUGGEST_TAB", "FAQ_sugeridas")
  },

  // Auto-mejora continua: el revisor evalúa conversaciones cada X minutos.
  autoimprove: {
    enabled: optional("AUTOIMPROVE", "on") !== "off",
    interval_min: parseInt(optional("AUTOIMPROVE_INTERVAL_MIN", "360"), 10) // 6h
  },

  // Instagram (Meta directo) — el bot responde DMs de IG con el mismo cerebro.
  // Se activa solo si hay IG_TOKEN. El webhook de verificación funciona igual sin token.
  instagram: {
    token: optional("IG_TOKEN", ""),                      // access token de la página/IG (enviar mensajes)
    verify_token: optional("IG_VERIFY_TOKEN", "winny-ig-2026"), // token para verificar el webhook en Meta
    ig_id: optional("IG_ID", ""),                         // (opcional) IG-scoped id de NUESTRA cuenta
    app_secret: optional("IG_APP_SECRET", "")             // (opcional) para verificar la firma del webhook
  },

  // Plantillas de WhatsApp (Twilio Content SID) para mensajes FUERA de la ventana
  // de 24h (notificación "en camino" y "entregado"). Si están vacías, se usa
  // mensaje de sesión normal (solo funciona dentro de las 24h).
  wa_templates: {
    en_camino: optional("TEMPLATE_EN_CAMINO_SID", ""),
    entregado: optional("TEMPLATE_ENTREGADO_SID", "")
  },

  // DB y storage
  db_path: optional("DB_PATH", "./data/winny-bot.db"),
  receipts_dir: optional("RECEIPTS_DIR", "./data/comprobantes"),
  invoices_dir: optional("INVOICES_DIR", "./data/facturas"),
  generated_dir: optional("GENERATED_DIR", "./data/generadas"),

  // Vertex AI Imagen — genera fotos de producto cuando NO hay foto real.
  // Reusa la MISMA cuenta de servicio de Google (scope cloud-platform).
  gcp: {
    // Deriva el project id del email de la cuenta de servicio (name@PROJECT.iam.gserviceaccount.com)
    project_id: optional("GOOGLE_PROJECT_ID", "") ||
      ((process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").split("@")[1] || "").split(".")[0],
    imagen_location: optional("IMAGEN_LOCATION", "us-central1"),
    imagen_model: optional("IMAGEN_MODEL", "imagen-3.0-generate-002")
  }
};

// Helper: ¿está abierto el negocio ahora?
export function is_business_open() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: config.business.timezone }));
  const day = now.getDay();
  const hour = now.getHours();
  return config.business.days.includes(day) &&
         hour >= config.business.hours_start &&
         hour < config.business.hours_end;
}
