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
    catalog_tab: optional("GOOGLE_CATALOG_TAB", "Catalogo")
  },

  // DB y storage
  db_path: optional("DB_PATH", "./data/winny-bot.db"),
  receipts_dir: optional("RECEIPTS_DIR", "./data/comprobantes"),
  invoices_dir: optional("INVOICES_DIR", "./data/facturas")
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
