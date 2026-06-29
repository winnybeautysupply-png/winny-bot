// ═══════════════════════════════════════════════════════════════
// WINNY BEAUTY BOT — Servidor principal (webhook WhatsApp Cloud API)
//
// Endpoints:
//   GET  /webhook   → verificación de Meta (token challenge)
//   POST /webhook   → mensajes entrantes
//   GET  /health    → status check
//   GET  /          → landing simple
// ═══════════════════════════════════════════════════════════════
import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { parse_incoming } from "./whatsapp.js";
import { handle_incoming } from "./handlers/messages.js";

const app = express();
// Twilio manda los webhooks como application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false, limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));

// ─── Health & landing ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.send(`
    <h1>🤖 Winny Beauty Bot</h1>
    <p>Bot inteligente de WhatsApp con Claude AI</p>
    <p>Status: <strong>online</strong></p>
    <p><a href="/health">/health</a></p>
  `);
});

import { is_business_open } from "./config.js";

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "winny-bot",
    timestamp: new Date().toISOString(),
    business: config.business.name,
    is_open: is_business_open()
  });
});

// ─── Webhook receiver (POST) — Twilio ────────────────────────────
// Twilio manda UN mensaje entrante por request, en form-encoded.
app.post("/webhook", async (req, res) => {
  // Responder TwiML vacío de inmediato para que Twilio no reintente
  res.set("Content-Type", "text/xml");
  res.send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");

  try {
    const body = req.body;

    // Twilio también manda callbacks de estado (delivered/read/sent) que
    // traen MessageStatus pero no Body/Media → los ignoramos.
    if (body.MessageStatus && !body.Body && !body.NumMedia) {
      logger.debug({ status: body.MessageStatus }, "Status callback recibido (ignorado)");
      return;
    }
    if (!body.From || !body.MessageSid) {
      logger.debug({ keys: Object.keys(body || {}) }, "Webhook sin mensaje válido");
      return;
    }

    const parsed = parse_incoming(body);
    logger.info({
      from: parsed.from,
      type: parsed.type,
      text_preview: (parsed.text || parsed.caption || "").slice(0, 50)
    }, "📨 Mensaje recibido");

    const contact_profile = parsed.profile_name ? { name: parsed.profile_name } : null;

    // Procesamiento async — no bloquea
    handle_incoming(parsed, contact_profile).catch(err => {
      logger.error({ err: err.message, from: parsed.from }, "Error procesando mensaje");
    });
  } catch (err) {
    logger.error({ err: err.message, body: req.body }, "Error en webhook POST");
  }
});

// ─── Error handler global ────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "internal_error" });
});

// ─── Start ───────────────────────────────────────────────────────
app.listen(config.port, () => {
  logger.info({
    port: config.port,
    business: config.business.name,
    claude_model: config.claude.model
  }, `🚀 Winny Bot escuchando en puerto ${config.port}`);

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     🌸  W I N N Y   B E A U T Y   B O T  🌸                  ║
║                                                               ║
║     Bot de WhatsApp con Claude AI                             ║
║     Status: online ✅                                         ║
║     Puerto: ${String(config.port).padEnd(50)} ║
║     Modelo IA: ${config.claude.model.padEnd(48)} ║
║                                                               ║
║     Webhook URL: https://TU-DOMINIO.com/webhook               ║
║     Número WA: ${config.twilio.whatsapp_number.padEnd(48)} ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});
