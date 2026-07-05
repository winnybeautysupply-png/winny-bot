// ═══════════════════════════════════════════════════════════════
// AUTO-MEJORA CONTINUA — cada X minutos revisa las conversaciones
// recientes (que no se han revisado), evalúa la calidad con Claude y:
//   • registra problemas/sugerencias en la hoja "Revisión"
//   • propone FAQs nuevas en "FAQ_sugeridas" (para que Winny apruebe)
//   • avisa a Winny SOLO las que necesitan intervención humana
// NUNCA reescribe el cerebro del bot solo (eso lo rompería): sugiere y
// registra; Winny aprueba las FAQs y el bot las usa. Nunca inventa.
// ═══════════════════════════════════════════════════════════════
import { config } from "./config.js";
import { logger } from "./logger.js";
import { get_conversations_to_review, mark_reviewed, get_recent_messages } from "./db.js";
import { review_conversation } from "./ai.js";
import { append_review_row, append_faq_suggestion } from "./sheets.js";
import { send_text } from "./whatsapp.js";

function fmt_date() {
  try { return new Date().toLocaleString("es-DO", { timeZone: config.business.timezone }); } catch { return ""; }
}
function only_digits(s) { return (s || "").toString().replace(/\D/g, ""); }

async function tick() {
  const owner = only_digits(config.business.owner_phone);
  const convos = get_conversations_to_review(24 * 60 * 60 * 1000, 15);
  if (!convos.length) return;
  for (const c of convos) {
    // No revisar la conversación de la propia dueña (modo jefa)
    if (only_digits(c.phone) === owner) { mark_reviewed(c.phone); continue; }
    const rows = get_recent_messages(c.phone, 20).map(r => ({
      role: r.direction === "in" ? "user" : "assistant", content: r.content || ""
    }));
    if (rows.length < 2) { mark_reviewed(c.phone); continue; }

    const rev = await review_conversation(rows);
    mark_reviewed(c.phone);
    if (!rev) continue;
    logger.info({ phone: c.phone, calidad: rev.calidad, necesita_humano: rev.necesita_humano }, "🧠 conversación revisada");

    // Registrar hallazgo si hubo problema, calidad baja, o necesita humano
    if (rev.problema || (rev.calidad ?? 10) < 7 || rev.necesita_humano) {
      await append_review_row([
        fmt_date(), `+${c.phone}`, rev.tema || "", rev.calidad ?? "",
        rev.problema || "", rev.respuesta_sugerida || "", rev.necesita_humano ? "SÍ" : "no"
      ]);
    }
    // FAQ sugerida (para que Winny la apruebe → luego el bot la usa)
    if (rev.faq_pregunta && rev.faq_respuesta) {
      await append_faq_suggestion([fmt_date(), rev.faq_pregunta, rev.faq_respuesta, `+${c.phone}`]);
    }
    // Avisar a Winny SOLO si necesita intervención humana
    if (rev.necesita_humano) {
      await send_text(config.business.owner_phone,
        `🔔 *Revisión:* la conversación con +${c.phone} (${rev.tema || "—"}) puede necesitar tu atención.` +
        (rev.problema ? `\nMotivo: ${rev.problema}` : ""));
    }
  }
}

let _timer = null;
export function start_improve_poller() {
  if (!config.autoimprove?.enabled) { logger.info("🧠 Auto-mejora: DESACTIVADA (AUTOIMPROVE=off)"); return; }
  if (!config.sheets.enabled) { logger.warn("🧠 Auto-mejora: Google Sheets no configurado — no arranca"); return; }
  const ms = Math.max(30, config.autoimprove.interval_min || 360) * 60 * 1000;
  _timer = setInterval(() => { tick().catch(e => logger.error({ err: e.message }, "Error en auto-mejora")); }, ms);
  logger.info({ cada_min: config.autoimprove.interval_min }, "🧠 Auto-mejora ACTIVA (revisa conversaciones periódicamente)");
}
