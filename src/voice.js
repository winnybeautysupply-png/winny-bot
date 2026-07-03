// ═══════════════════════════════════════════════════════════════
// Llamadas de VOZ — Twilio ConversationRelay sobre WebSocket.
// Twilio hace STT (voz→texto) y TTS (texto→voz); nosotros ponemos el
// cerebro (Claude) con el mismo catálogo/prompt, en estilo de voz.
//
// Flujo de mensajes del WebSocket de ConversationRelay:
//   setup   → metadata de la llamada (callSid, from, to)
//   prompt  → lo que dijo la clienta (transcrito) en `voicePrompt`
//   interrupt → la clienta interrumpió al bot
// Respondemos con: { type:"text", token:"<texto a decir>", last:true }
// ═══════════════════════════════════════════════════════════════
import { WebSocketServer } from "ws";
import { logger } from "./logger.js";
import { generate_voice_response } from "./ai.js";
import { save_message, get_recent_messages, upsert_contact } from "./db.js";

function history_for(from) {
  if (!from) return [];
  try {
    return get_recent_messages(from, 8)
      .map(r => ({ role: r.direction === "in" ? "user" : "assistant", content: r.content || "" }));
  } catch { return []; }
}

export function setup_voice_ws(server) {
  const wss = new WebSocketServer({ server, path: "/voice/ws" });

  wss.on("connection", (ws) => {
    let from = null; // teléfono de la clienta (para memoria por número)
    logger.info("📞 Voz: WebSocket conectado");

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // ── setup: inicio de la llamada ──
      if (msg.type === "setup") {
        from = (msg.from || "").replace(/\D/g, "") || null;
        logger.info({ from, callSid: msg.callSid }, "📞 Voz: setup (llamada iniciada)");
        try { if (from) upsert_contact(from); } catch { /* no crítico */ }
        return;
      }

      // ── prompt: la clienta dijo algo (ya transcrito) ──
      if (msg.type === "prompt") {
        const text = (msg.voicePrompt || "").trim();
        if (!text) return;
        logger.info({ from, text: text.slice(0, 100) }, "📞 Voz: prompt (clienta)");
        try {
          const history = history_for(from);
          const reply = await generate_voice_response(text, history);
          logger.info({ from, reply: reply.slice(0, 100) }, "📞 Voz: respuesta");
          if (from) {
            // Guardado como 'text' para que entre en la memoria de conversación (get_recent_messages)
            save_message({ phone: from, direction: "in", type: "text", content: `(llamada) ${text}`, wa_message_id: null });
            save_message({ phone: from, direction: "out", type: "text", content: reply, wa_message_id: null });
          }
          ws.send(JSON.stringify({ type: "text", token: reply, last: true }));
        } catch (err) {
          logger.error({ err: err.message, from }, "📞 Voz: error generando respuesta");
          ws.send(JSON.stringify({ type: "text", token: "Disculpa, tuve un problemita. ¿Me repites por favor?", last: true }));
        }
        return;
      }

      // ── interrupt: la clienta interrumpió (no hacemos streaming, solo lo notamos) ──
      if (msg.type === "interrupt") {
        logger.info({ from }, "📞 Voz: interrupt (clienta interrumpió)");
        return;
      }
    });

    ws.on("close", () => logger.info({ from }, "📞 Voz: WebSocket cerrado (llamada terminó)"));
    ws.on("error", (e) => logger.error({ err: e.message }, "📞 Voz: error de WebSocket"));
  });

  logger.info("📞 Voz: servidor WebSocket listo en /voice/ws");
  return wss;
}
