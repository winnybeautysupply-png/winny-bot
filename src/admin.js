// ═══════════════════════════════════════════════════════════════
// VISOR PRIVADO — página web para que Winny vea las conversaciones
// del bot con sus clientas. Protegida por la variable de entorno
// ADMIN_KEY (si no está, el visor queda deshabilitado).
//   /admin?key=CLAVE              → lista de clientas
//   /admin?key=CLAVE&phone=XXXX   → conversación con esa clienta
// ═══════════════════════════════════════════════════════════════
import db, { get_recent_inbound_contacts, save_message } from "./db.js";
import { send_text, send_image } from "./whatsapp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

const ADMIN_KEY = process.env.ADMIN_KEY || "";

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleString("es-DO", {
      timeZone: "America/Santo_Domingo",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  } catch { return ""; }
}

function prettyName(phone, name) {
  if (name) return name;
  if (!phone) return "—";
  if (phone.startsWith("ig:")) return "📸 Instagram";
  return phone.replace(/^whatsapp:/, "");
}

function shell(title, inner) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--pink:#c2185b}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:#f0f2f5;color:#222}
header{background:var(--pink);color:#fff;padding:14px 16px;font-weight:700;font-size:1.05rem;position:sticky;top:0;z-index:5}
a{color:var(--pink);text-decoration:none}
.wrap{max-width:820px;margin:0 auto;padding:12px 14px 70px}
.item{display:block;background:#fff;border-radius:12px;padding:12px 14px;margin:8px 0;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.item .n{font-weight:700}
.item .p{color:#667;font-size:.85rem;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{float:right;color:#9aa;font-size:.72rem;margin-left:8px}
.msg{max-width:80%;padding:8px 12px;border-radius:14px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word;font-size:.95rem;line-height:1.35;clear:both}
.in{background:#fff;border:1px solid #eaeaea;float:left;border-bottom-left-radius:4px}
.out{background:#dcf8c6;float:right;border-bottom-right-radius:4px}
.meta{font-size:.68rem;color:#9aa;margin-top:3px;text-align:right}
.back{display:inline-block;margin:4px 0 10px}
.hd{font-weight:700;font-size:1.15rem;margin:2px 0 12px}
.sub{color:#667;font-size:.9rem;margin:0 0 6px}
.clear{clear:both}
form.login{max-width:340px;margin:60px auto;background:#fff;padding:26px;border-radius:14px;text-align:center;box-shadow:0 2px 10px rgba(0,0,0,.08)}
input,button{font-size:1rem;padding:11px;border-radius:9px;border:1px solid #ccc;width:100%;margin-top:10px}
button{background:var(--pink);color:#fff;border:0;font-weight:700;cursor:pointer}
</style></head><body><header>🌸 Winny Bot — Conversaciones</header><div class="wrap">${inner}</div></body></html>`;
}

function loginForm(msg) {
  return shell("Acceso", `<form class="login" method="get" action="/admin">
    ${msg ? `<p style="color:#c00;font-weight:600">${esc(msg)}</p>` : ""}
    <p>Escribe tu clave para ver las conversaciones del bot 💕</p>
    <input name="key" type="password" placeholder="Clave" autofocus>
    <button type="submit">Entrar</button></form>`);
}

function contactsList() {
  const rows = db.prepare(`
    SELECT c.phone AS phone, c.name AS name, c.last_seen AS last_seen,
      (SELECT m.content FROM messages m
        WHERE m.phone = c.phone AND m.type = 'text'
        ORDER BY m.timestamp DESC LIMIT 1) AS last_text
    FROM contacts c
    ORDER BY c.last_seen DESC
    LIMIT 400
  `).all();

  const items = rows.map(r => {
    const disp = prettyName(r.phone, r.name);
    const prev = (r.last_text || "").replace(/\s+/g, " ").slice(0, 70);
    return `<a class="item" href="/admin?key=${encodeURIComponent(ADMIN_KEY)}&phone=${encodeURIComponent(r.phone)}">
      <span class="time">${fmtTime(r.last_seen)}</span>
      <div class="n">${esc(disp)}</div>
      <div class="p">${esc(prev) || "&nbsp;"}</div></a>`;
  }).join("");

  return shell("Conversaciones",
    `<p class="sub">${rows.length} clientas — toca una para ver el chat completo</p>${items || "<p>Todavía no hay conversaciones.</p>"}`);
}

function conversation(phone) {
  const c = db.prepare("SELECT name FROM contacts WHERE phone = ?").get(phone);
  const msgs = db.prepare(`
    SELECT direction, type, content, timestamp
    FROM messages WHERE phone = ?
    ORDER BY timestamp ASC LIMIT 2000
  `).all(phone);
  const disp = prettyName(phone, c && c.name);

  const body = msgs.map(m => {
    let text = m.content || "";
    if (m.type !== "text") text = `[${m.type === "image" ? "imagen 📷" : m.type}]`;
    const who = m.direction === "out" ? "out" : "in";
    return `<div class="msg ${who}">${esc(text)}<div class="meta">${fmtTime(m.timestamp)}</div></div>`;
  }).join("") + `<div class="clear"></div>`;

  return shell(disp,
    `<a class="back" href="/admin?key=${encodeURIComponent(ADMIN_KEY)}">← Todas las clientas</a>
     <div class="hd">${esc(disp)}</div>
     <div class="sub">${esc(phone.replace(/^whatsapp:/, ""))} · ${msgs.length} mensajes</div>
     ${body || "<p>Sin mensajes.</p>"}`);
}

export function mount_admin(app) {
  app.get("/admin", (req, res) => {
    if (!ADMIN_KEY) return res.status(503).send("El visor no está configurado (falta ADMIN_KEY).");
    if (req.query.key !== ADMIN_KEY) {
      return res.status(req.query.key ? 401 : 200).send(loginForm(req.query.key ? "Clave incorrecta" : ""));
    }
    if (req.query.phone) return res.send(conversation(String(req.query.phone)));
    return res.send(contactsList());
  });

  mount_flash(app);
}

// ── Destinatarias elegibles para la oferta flash ──
// Clientas con mensaje entrante dentro de la ventana, EXCLUYENDO a la dueña y a
// los contactos de Instagram (ig:) que no se pueden contactar por Twilio/WhatsApp.
function flash_recipients(windowMs) {
  const owner = (config.business.owner_phone || "").replace(/\D/g, "");
  return get_recent_inbound_contacts(windowMs)
    .filter(r => r.phone && !r.phone.startsWith("ig:"))
    .filter(r => r.phone.replace(/\D/g, "") !== owner);
}

// ═══════════════════════════════════════════════════════════════
// OFERTA FLASH — enviar un mensaje a las clientas dentro de la ventana de 24h.
//   GET  /flash?key=KEY[&hours=24]                 → PREVISUALIZA (cuántas + quiénes), NO envía
//   POST /flash  (key, msg, [img], [hours], send=1) → ENVÍA a todas las elegibles
// Protegido por ADMIN_KEY. El envío exige send=1 + msg para evitar disparos accidentales.
// ═══════════════════════════════════════════════════════════════
function mount_flash(app) {
  app.all("/flash", async (req, res) => {
    if (!ADMIN_KEY) return res.status(503).json({ error: "falta ADMIN_KEY" });
    const src = { ...(req.query || {}), ...(req.body || {}) };
    if (src.key !== ADMIN_KEY) return res.status(401).json({ error: "clave incorrecta" });

    const hours = Math.max(1, Math.min(24, parseInt(src.hours || "24", 10) || 24));
    const windowMs = hours * 60 * 60 * 1000;
    const recips = flash_recipients(windowMs);
    const msg = (src.msg || "").toString();
    const img = (src.img || "").toString();
    const doSend = String(src.send || "") === "1";

    // PREVISUALIZAR (por defecto): devuelve la lista sin enviar nada.
    if (!doSend) {
      return res.json({
        modo: "previsualizacion",
        ventana_horas: hours,
        elegibles: recips.length,
        destinatarias: recips.map(r => ({
          phone: r.phone, nombre: r.name || null, ultimo_mensaje: fmtTime(r.last_in)
        }))
      });
    }

    // ENVIAR: requiere mensaje.
    if (!msg.trim()) return res.status(400).json({ error: "falta el texto (msg)" });

    logger.info({ elegibles: recips.length, con_imagen: !!img, hours }, "📣 Oferta flash — iniciando envío");
    let enviados = 0, fallidos = 0;
    const detalle = [];
    for (const r of recips) {
      try {
        const sid = (img && img.startsWith("http"))
          ? await send_image(r.phone, img, msg)
          : await send_text(r.phone, msg);
        if (sid) {
          enviados++;
          save_message({ phone: r.phone, direction: "out", type: img ? "image" : "text", content: msg, wa_message_id: sid });
        } else { fallidos++; }
        detalle.push({ phone: r.phone, ok: !!sid });
      } catch (e) {
        fallidos++;
        detalle.push({ phone: r.phone, ok: false, error: e.message });
      }
    }
    logger.info({ enviados, fallidos, total: recips.length }, "📣 Oferta flash — envío terminado");
    return res.json({ modo: "envio", ventana_horas: hours, total: recips.length, enviados, fallidos, detalle });
  });
}
