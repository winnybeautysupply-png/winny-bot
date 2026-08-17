// ═══════════════════════════════════════════════════════════════
// VISOR PRIVADO — página web para que Winny vea las conversaciones
// del bot con sus clientas. Protegida por la variable de entorno
// ADMIN_KEY (si no está, el visor queda deshabilitado).
//   /admin?key=CLAVE              → lista de clientas
//   /admin?key=CLAVE&phone=XXXX   → conversación con esa clienta
// ═══════════════════════════════════════════════════════════════
import db, { get_recent_inbound_contacts, save_message, get_open_orders, set_handoff, clear_handoff, is_handed_off } from "./db.js";
import { send_text, send_image } from "./whatsapp.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import multer from "multer";
import path from "path";

// Subida de foto/video desde el panel → se guarda en el disco persistente
// (carpeta de comprobantes, servida en /comprobantes) y se manda como media de WhatsApp.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.receipts_dir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || "") || ".jpg").toLowerCase().slice(0, 6);
      cb(null, `panel_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16 MB (límite de WhatsApp para video)
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype || ""))
});

const ADMIN_KEY = process.env.ADMIN_KEY || "";
// Clave de EMPLEADA: acceso limitado al panel (ver + responder). NO puede ver
// /pending ni disparar /flash. Se rota cambiando EMPLOYEE_KEY en Render sin
// tocar la clave de la jefa.
const EMPLOYEE_KEY = process.env.EMPLOYEE_KEY || "";

// ¿Qué rol tiene esta clave? "jefa" | "empleada" | null
function key_role(k) {
  if (ADMIN_KEY && k === ADMIN_KEY) return "jefa";
  if (EMPLOYEE_KEY && k === EMPLOYEE_KEY) return "empleada";
  return null;
}

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
form.reply{position:sticky;bottom:0;background:#f0f2f5;padding:10px 0 6px;clear:both}
form.reply textarea{width:100%;font-size:1rem;padding:10px;border-radius:10px;border:1px solid #ccc;resize:vertical;font-family:inherit}
form.reply .row{display:flex;gap:10px;align-items:center;margin-top:8px}
form.reply .row label{flex:1;font-size:.82rem;color:#556}
form.reply .row button{width:auto;padding:10px 22px;margin-top:0}
.notice{background:#e8f5e9;border:1px solid #c8e6c9;color:#256029;padding:9px 12px;border-radius:9px;margin:8px 0}
.notice.err{background:#fdecea;border-color:#f5c6cb;color:#8a1c24}
</style></head><body><header>🌸 Winny Bot — Conversaciones</header><div class="wrap">${inner}</div></body></html>`;
}

function loginForm(msg) {
  return shell("Acceso", `<form class="login" method="get" action="/admin">
    ${msg ? `<p style="color:#c00;font-weight:600">${esc(msg)}</p>` : ""}
    <p>Escribe tu clave para ver las conversaciones del bot 💕</p>
    <input name="key" type="password" placeholder="Clave" autofocus>
    <button type="submit">Entrar</button></form>`);
}

function contactsList(key) {
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
    return `<a class="item" href="/admin?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(r.phone)}">
      <span class="time">${fmtTime(r.last_seen)}</span>
      <div class="n">${esc(disp)}</div>
      <div class="p">${esc(prev) || "&nbsp;"}</div></a>`;
  }).join("");

  return shell("Conversaciones",
    `<p class="sub">${rows.length} clientas — toca una para ver el chat completo</p>${items || "<p>Todavía no hay conversaciones.</p>"}`);
}

function conversation(phone, notice, key) {
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

  // Cajita para que WINNY responda directo desde el panel (llega por WhatsApp
  // desde el número del bot). Solo para chats de WhatsApp (no Instagram).
  const paused = is_handed_off(phone);
  const replyBox = phone.startsWith("ig:") ? "" : `
    <form class="reply" method="post" action="/admin/reply" enctype="multipart/form-data">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="phone" value="${esc(phone)}">
      <textarea name="msg" rows="2" placeholder="Escribe tu mensaje como Winny…"></textarea>
      <input type="file" name="media" accept="image/*,video/*" style="margin-top:8px">
      <div class="row">
        <label><input type="checkbox" name="pausar" value="1" ${paused ? "checked" : ""}> pausar el bot 1h (la atiendes tú)</label>
        <button type="submit">Enviar 💬</button>
      </div>
    </form>
    <p class="sub" style="margin-top:6px">${paused ? "🔇 Bot en pausa con esta clienta." : "🤖 Bot activo con esta clienta."} Ojo: si su último mensaje tiene más de 24h, WhatsApp puede rechazar el envío.</p>`;

  return shell(disp,
    `<a class="back" href="/admin?key=${encodeURIComponent(key)}">← Todas las clientas</a>
     <div class="hd">${esc(disp)}</div>
     <div class="sub">${esc(phone.replace(/^whatsapp:/, ""))} · ${msgs.length} mensajes</div>
     ${notice || ""}
     ${body || "<p>Sin mensajes.</p>"}
     ${replyBox}`);
}

export function mount_admin(app) {
  app.get("/admin", (req, res) => {
    if (!ADMIN_KEY) return res.status(503).send("El visor no está configurado (falta ADMIN_KEY).");
    const role = key_role(req.query.key);
    if (!role) {
      return res.status(req.query.key ? 401 : 200).send(loginForm(req.query.key ? "Clave incorrecta" : ""));
    }
    if (req.query.phone) {
      const notice = req.query.sent === "1"
        ? `<div class="notice">✅ Mensaje enviado a la clienta.</div>`
        : (req.query.err ? `<div class="notice err">⚠️ ${esc(req.query.err)}</div>` : "");
      return res.send(conversation(String(req.query.phone), notice, String(req.query.key)));
    }
    return res.send(contactsList(String(req.query.key)));
  });

  // RESPONDER desde el panel: Winny escribe y le llega a la clienta por WhatsApp
  // desde el número del bot. Opcional: pausar el bot 1h para atenderla a mano.
  app.post("/admin/reply", upload.single("media"), async (req, res) => {
    if (!ADMIN_KEY) return res.status(503).send("Falta ADMIN_KEY.");
    const { key, phone, msg, pausar } = req.body || {};
    const role = key_role(key);
    if (!role) return res.status(401).send("Clave incorrecta.");
    const back = `/admin?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(phone || "")}`;
    const text = (msg || "").trim();
    const file = req.file || null;
    if (!phone || (!text && !file)) return res.redirect(back + "&err=" + encodeURIComponent("Escribe un mensaje o adjunta una foto/video."));
    try {
      let sid;
      if (file) {
        const media_url = `${config.public_base_url}/comprobantes/${file.filename}`;
        sid = await send_image(phone, media_url, text); // sirve para foto Y video (MediaUrl de Twilio)
      } else {
        sid = await send_text(phone, text);
      }
      if (!sid) return res.redirect(back + "&err=" + encodeURIComponent("WhatsApp rechazó el envío (¿ventana de 24h vencida?)."));
      save_message({
        phone, direction: "out",
        type: file ? (/^video\//.test(file.mimetype) ? "video" : "image") : "text",
        content: text || (file ? "[foto/video del panel]" : ""),
        media_path: file ? file.path : null,
        wa_message_id: sid
      });
      if (pausar === "1") set_handoff(phone, 60); else clear_handoff(phone);
      logger.info({ phone, desde: `panel-${role}`, con_media: !!file }, `💬 Respuesta desde el panel (${role})`);
      return res.redirect(back + "&sent=1");
    } catch (e) {
      logger.error({ err: e.message, phone }, "Error enviando desde el panel");
      return res.redirect(back + "&err=" + encodeURIComponent("Error: " + e.message));
    }
  });

  mount_flash(app);
  mount_pending(app);
}

// ═══ AUDITORÍA de pedidos abiertos — GET /pending?key=ADMIN_KEY ═══
// Lista clientas colgadas (pagaron y no se cerró, o pendientes), con días de antigüedad.
function mount_pending(app) {
  app.get("/pending", (req, res) => {
    if (!ADMIN_KEY) return res.status(503).json({ error: "falta ADMIN_KEY" });
    if (req.query.key !== ADMIN_KEY) return res.status(401).json({ error: "clave incorrecta" });
    const now = Date.now();
    const estados = {
      awaiting_verification: "PAGÓ — falta confirmar ⚠️",
      paid: "Pagado — falta enviar 📦",
      awaiting_payment: "Esperando pago del cliente",
      draft: "Carrito sin terminar"
    };
    let rows;
    try { rows = get_open_orders(); } catch (e) { return res.status(500).json({ error: e.message }); }
    const orders = rows.map(o => {
      let items = o.items;
      if (typeof items === "string") { try { items = JSON.parse(items); } catch { items = []; } }
      const prods = Array.isArray(items)
        ? items.map(p => `${p.cantidad || 1}× ${p.nombre}${p.detalles ? " (" + p.detalles + ")" : ""}`).join(", ")
        : "";
      const dias = Math.floor((now - (o.created_at || now)) / 86400000);
      return {
        id: o.id, telefono: o.phone, nombre: o.customer_name || o.contact_name || "",
        estado: estados[o.status] || o.status, dias_esperando: dias,
        productos: prods, total: o.total || null,
        tiene_comprobante: !!o.receipt_path,
        fecha: new Date(o.created_at || now).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" })
      };
    });
    res.json({
      total_abiertos: orders.length,
      pagaron_falta_confirmar: orders.filter(o => /confirmar/.test(o.estado)).length,
      pagado_falta_enviar: orders.filter(o => /enviar/.test(o.estado)).length,
      pedidos: orders
    });
  });
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
