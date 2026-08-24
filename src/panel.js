// ═══════════════════════════════════════════════════════════════
// PANEL v2 — Centro de operaciones de Winny Beauty Supply
//
// No es "un visor de mensajes": es la mesa de trabajo del negocio.
//   /panel?key=CLAVE                → BANDEJA con estados (🔴 pendiente,
//                                     🟡 esperando, 🤖 IA, 👤 humano)
//   /panel/chat?key=&phone=         → conversación + ficha de la clienta
//                                     + resumen de IA + catálogo rápido
//   /panel/dashboard?key=           → números del día (SOLO jefa)
//
// El cerebro (Claude) sigue siendo el mismo y vive aparte: este archivo
// solo lee/escribe la MISMA base de datos y usa los MISMOS envíos de
// WhatsApp. Si Claude se cambia mañana, el panel no se toca.
//
// Roles: ADMIN_KEY = jefa (todo) · EMPLOYEE_KEY = empleada (bandeja+chat).
// ═══════════════════════════════════════════════════════════════
import path from "path";
import multer from "multer";
import Anthropic from "@anthropic-ai/sdk";
import db, { set_handoff, clear_handoff, is_handed_off, mark_human_reply } from "./db.js";
import { send_text, send_image } from "./whatsapp.js";
import { find_products, get_offers, get_by_code } from "./catalog.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ─── Migraciones propias del panel (no tocan el resto del bot) ───
for (const col of [
  "notes TEXT",              // notas del equipo sobre la clienta
  "tags TEXT",               // etiquetas separadas por coma
  "panel_ai TEXT",           // último análisis de IA (JSON)
  "panel_ai_at INTEGER DEFAULT 0",
  "taken_by TEXT"            // quién tomó la conversación (jefa/empleada)
]) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${col}`); } catch { /* ya existe */ }
}
// Marca de QUIÉN mandó cada mensaje saliente: null/"ia" = el bot, "humano" = el panel.
try { db.exec("ALTER TABLE messages ADD COLUMN source TEXT"); } catch { /* ya existe */ }

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const EMPLOYEE_KEY = process.env.EMPLOYEE_KEY || "";
const AI_MODEL = process.env.PANEL_AI_MODEL || config.claude.model;

const claude = new Anthropic({ apiKey: config.claude.api_key, timeout: 40000, maxRetries: 1 });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.receipts_dir),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || "") || ".jpg").toLowerCase().slice(0, 6);
      cb(null, `panel_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^(image|video)\//.test(file.mimetype || ""))
});

// ─── Utilidades ──────────────────────────────────────────────────
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
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleString("es-DO", {
      timeZone: "America/Santo_Domingo",
      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
    });
  } catch { return ""; }
}

// "hace 12 min" / "hace 3 h" / "hace 2 d" — para ver de un vistazo quién lleva esperando.
function hace(ts) {
  if (!ts) return "—";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "ahora";
  if (m < 60) return `hace ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

function rd(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("es-DO") : "—";
}

function prettyName(phone, name) {
  if (name) return name;
  if (!phone) return "—";
  if (phone.startsWith("ig:")) return "📸 Instagram";
  return phone.replace(/^whatsapp:/, "");
}

function ownerDigits() {
  return (config.business.owner_phone || "").replace(/\D/g, "");
}

// Inicio del día en horario de Santo Domingo (UTC-4 fijo, RD no usa horario de verano).
function inicioDelDia() {
  const off = 4 * 3600000;
  return Math.floor((Date.now() - off) / 86400000) * 86400000 + off;
}

// Guarda un mensaje SALIENTE marcando que lo mandó un humano desde el panel.
function save_out(phone, { type = "text", content = "", media_path = null, sid = null, source = "humano" }) {
  db.prepare(`INSERT INTO messages (phone, direction, type, content, media_path, wa_message_id, timestamp, source)
              VALUES (?, 'out', ?, ?, ?, ?, ?, ?)`)
    .run(phone, type, content || null, media_path, sid, Date.now(), source);
}

// ─── Consultas de la bandeja ─────────────────────────────────────

// Una fila por clienta con todo lo que la bandeja necesita para pintar el estado.
function inbox_rows(limit = 300) {
  const owner = ownerDigits();
  const rows = db.prepare(`
    SELECT c.phone AS phone, c.name AS name, c.last_seen AS last_seen,
           c.handed_off_until AS handoff, c.tags AS tags, c.panel_ai AS panel_ai,
           c.taken_by AS taken_by,
           (SELECT m.content FROM messages m WHERE m.phone = c.phone AND m.type = 'text'
              ORDER BY m.timestamp DESC LIMIT 1) AS last_text,
           (SELECT MAX(m.timestamp) FROM messages m WHERE m.phone = c.phone AND m.direction = 'in') AS last_in,
           (SELECT MAX(m.timestamp) FROM messages m WHERE m.phone = c.phone AND m.direction = 'out') AS last_out
    FROM contacts c
    ORDER BY c.last_seen DESC
    LIMIT ?
  `).all(limit);

  const now = Date.now();
  return rows
    .filter(r => r.phone && r.phone.replace(/\D/g, "") !== owner)
    .map(r => {
      const esperando_respuesta = (r.last_in || 0) > (r.last_out || 0);
      const humano = (r.handoff || 0) > now;
      let ai = null;
      try { ai = r.panel_ai ? JSON.parse(r.panel_ai) : null; } catch { ai = null; }
      return {
        ...r,
        ai,
        atendida_por: humano ? "humano" : "ia",
        estado: esperando_respuesta ? "pendiente" : "esperando",
        urgente: !!(ai && ai.necesita_humano) && esperando_respuesta
      };
    });
}

function contar(rows) {
  return {
    pendientes: rows.filter(r => r.estado === "pendiente").length,
    esperando: rows.filter(r => r.estado === "esperando").length,
    ia: rows.filter(r => r.atendida_por === "ia").length,
    humano: rows.filter(r => r.atendida_por === "humano").length,
    urgentes: rows.filter(r => r.urgente).length
  };
}

// Ficha comercial de la clienta: compras, gasto, último pedido.
function ficha(phone) {
  const c = db.prepare(`SELECT phone, name, first_seen, last_seen, summary, notes, tags,
                               panel_ai, panel_ai_at, taken_by, handed_off_until
                        FROM contacts WHERE phone = ?`).get(phone) || { phone };
  const compras = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(total), 0) AS gastado
    FROM orders WHERE phone = ? AND status IN ('paid', 'shipped', 'delivered')
  `).get(phone) || { n: 0, gastado: 0 };
  const ultimo = db.prepare(`
    SELECT id, status, items, total, created_at, guia_envio, empresa_envio
    FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 1
  `).get(phone) || null;
  const abiertos = db.prepare(`
    SELECT COUNT(*) AS n FROM orders WHERE phone = ?
    AND status IN ('awaiting_verification', 'paid', 'awaiting_payment')
  `).get(phone)?.n || 0;
  const nmsgs = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE phone = ?").get(phone)?.n || 0;
  let ai = null;
  try { ai = c.panel_ai ? JSON.parse(c.panel_ai) : null; } catch { ai = null; }
  return { c, compras, ultimo, abiertos, nmsgs, ai };
}

const ESTADOS_PEDIDO = {
  draft: "Carrito sin terminar",
  awaiting_payment: "Esperando pago",
  awaiting_verification: "Pagó — falta confirmar ⚠️",
  awaiting_address: "Falta dirección",
  paid: "Pagado — falta enviar 📦",
  shipped: "Enviado 🚚",
  delivered: "Entregado ✅",
  cancelled: "Cancelado"
};

function productos_de(items) {
  let arr = items;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return "";
  return arr.map(p => `${p.cantidad || 1}× ${p.nombre}${p.detalles ? ` (${p.detalles})` : ""}`).join(", ");
}

// ─── Análisis de IA de una conversación (bajo demanda, no automático) ───
async function analizar(phone) {
  const msgs = db.prepare(`
    SELECT direction, content FROM messages
    WHERE phone = ? AND type = 'text' AND content IS NOT NULL
    ORDER BY timestamp DESC LIMIT 30
  `).all(phone).reverse();
  if (!msgs.length) return null;

  const convo = msgs.map(m => `${m.direction === "in" ? "CLIENTA" : "TIENDA"}: ${m.content}`).join("\n");
  const f = ficha(phone);
  const compras = f.compras.n
    ? `${f.compras.n} compras, RD$${rd(f.compras.gastado)} en total`
    : "sin compras registradas";

  const resp = await claude.messages.create({
    model: AI_MODEL,
    max_tokens: 500,
    temperature: 0,
    system: "Eres la supervisora de ventas de una tienda de belleza dominicana (pelucas, cabello, productos de instalación). Lees una conversación de WhatsApp entre la tienda y una clienta y devuelves SOLO un JSON, sin texto alrededor, con estas claves exactas: resumen (string, 2 frases máximo, en español, qué quiere la clienta y en qué punto está), intencion (string corto: 'Comprar' | 'Preguntando precio' | 'Reclamo' | 'Seguimiento de pedido' | 'Solo mirando' | 'Otro'), producto (string, qué producto concreto le interesa, o '' si no está claro), probabilidad (string: 'Alta' | 'Media' | 'Baja' — probabilidad de que compre), necesita_humano (boolean: true si hay reclamo, molestia, negociación, pedido grande, problema de pago/envío, o pide hablar con una persona), motivo_humano (string corto, '' si necesita_humano es false), sugerencia (string, 1 frase: el próximo paso concreto que debe dar la tienda para cerrar la venta). No inventes datos que no estén en la conversación.",
    messages: [{ role: "user", content: `HISTORIAL DE COMPRAS: ${compras}\n\nCONVERSACIÓN:\n${convo}\n\nDevuelve el JSON.` }]
  });

  const text = resp.content?.find(b => b.type === "text")?.text?.trim() || "";
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const data = JSON.parse(m[0]);
  db.prepare("UPDATE contacts SET panel_ai = ?, panel_ai_at = ? WHERE phone = ?")
    .run(JSON.stringify(data), Date.now(), phone);
  return data;
}

// ─── HTML ────────────────────────────────────────────────────────
function shell(title, inner, { key = "", role = "", activa = "" } = {}) {
  const k = encodeURIComponent(key);
  const nav = key ? `
    <nav class="nav">
      <a class="${activa === "bandeja" ? "on" : ""}" href="/panel?key=${k}">📥 Bandeja</a>
      ${role === "jefa" ? `<a class="${activa === "dash" ? "on" : ""}" href="/panel/dashboard?key=${k}">📊 Números</a>` : ""}
      ${role === "jefa" ? `<a href="/pending?key=${k}">🧾 Pedidos abiertos</a>` : ""}
    </nav>` : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--pink:#c2185b;--pink-soft:#fce4ec;--ink:#232326;--soft:#6b7280;--line:#e7e7ec;--bg:#f4f5f7}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
header{background:var(--pink);color:#fff;padding:12px 16px;font-weight:700;position:sticky;top:0;z-index:9;
  display:flex;justify-content:space-between;align-items:center;gap:10px}
header .rol{font-weight:500;font-size:.78rem;opacity:.9;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:20px}
.nav{display:flex;gap:6px;background:#fff;border-bottom:1px solid var(--line);padding:8px 12px;
  position:sticky;top:44px;z-index:8;overflow-x:auto}
.nav a{white-space:nowrap;color:var(--soft);text-decoration:none;font-size:.85rem;font-weight:600;
  padding:6px 11px;border-radius:20px}
.nav a.on{background:var(--pink-soft);color:var(--pink)}
a{color:var(--pink);text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding:12px 14px 80px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:12px}
.tile{background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px 12px;text-align:center;display:block}
.tile b{display:block;font-size:1.5rem;line-height:1.2}
.tile span{font-size:.72rem;color:var(--soft)}
.tile.sel{border-color:var(--pink);background:var(--pink-soft)}
.item{display:block;background:#fff;border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin:8px 0}
.item .n{font-weight:700;font-size:.98rem}
.item .p{color:var(--soft);font-size:.84rem;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.time{float:right;color:#9aa1ac;font-size:.72rem;margin-left:8px}
.pill{display:inline-block;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:20px;margin-right:5px}
.pill.rojo{background:#fdecea;color:#b3261e}
.pill.amar{background:#fff6e0;color:#8a6100}
.pill.ia{background:#e8f0fe;color:#1a56c4}
.pill.hum{background:#e9f7ec;color:#1e6b32}
.pill.tag{background:#f2eef7;color:#5b3fa0}
.pill.urg{background:#b3261e;color:#fff}
.chatgrid{display:grid;grid-template-columns:1fr;gap:14px;align-items:start}
@media(min-width:1000px){.chatgrid{grid-template-columns:minmax(0,1fr) 330px}}
.card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:13px 15px;margin-bottom:12px}
.card h3{margin:0 0 9px;font-size:.82rem;text-transform:uppercase;letter-spacing:.5px;color:var(--soft)}
.kv{display:flex;justify-content:space-between;gap:10px;padding:4px 0;font-size:.88rem;border-bottom:1px dashed #f0f0f4}
.kv:last-child{border:0}
.kv span{color:var(--soft)}
.chat{background:#fff;border:1px solid var(--line);border-radius:14px;padding:12px}
.msg{max-width:82%;padding:8px 12px;border-radius:14px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word;
  font-size:.93rem;line-height:1.4;clear:both}
.in{background:#f2f3f5;float:left;border-bottom-left-radius:4px}
.out{background:#dcf8c6;float:right;border-bottom-right-radius:4px}
.out.hum{background:#cfe8ff}
.msg img,.msg video{max-width:100%;border-radius:9px;display:block;margin-top:5px}
.meta{font-size:.66rem;color:#98a0ab;margin-top:3px;text-align:right}
.clear{clear:both}
textarea,input[type=text],input[type=password],input[type=search]{width:100%;font-size:1rem;padding:10px;
  border-radius:10px;border:1px solid #ccd0d6;font-family:inherit}
button{background:var(--pink);color:#fff;border:0;font-weight:700;cursor:pointer;padding:10px 16px;
  border-radius:10px;font-size:.92rem}
button.ghost{background:#fff;color:var(--pink);border:1.5px solid var(--pink)}
button.grey{background:#eceef1;color:#444}
button.big{width:100%;padding:13px;font-size:1rem;margin-top:8px}
form.login{max-width:340px;margin:60px auto;background:#fff;padding:26px;border-radius:14px;text-align:center}
form.login button{width:100%;margin-top:12px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.notice{background:#e9f7ec;border:1px solid #c9e8d2;color:#1e6b32;padding:9px 12px;border-radius:10px;margin:8px 0;font-size:.9rem}
.notice.err{background:#fdecea;border-color:#f6ccc8;color:#8a1c24}
.ai{background:linear-gradient(180deg,#fff,#faf7ff);border:1px solid #e6dcf5}
.ai .txt{font-size:.92rem;line-height:1.45}
.prod{display:flex;gap:10px;align-items:center;background:#fff;border:1px solid var(--line);
  border-radius:12px;padding:9px;margin:7px 0}
.prod img{width:56px;height:56px;object-fit:cover;border-radius:9px;background:#f0f0f4}
.prod .info{flex:1;min-width:0;font-size:.86rem}
.prod .info b{display:block}
.muted{color:var(--soft);font-size:.85rem}
details summary{cursor:pointer;font-weight:700;font-size:.9rem;color:var(--pink);padding:4px 0}
</style></head><body>
<header><span>🌸 Winny — Centro de atención</span>${role ? `<span class="rol">${esc(role)}</span>` : ""}</header>
${nav}
<div class="wrap">${inner}</div></body></html>`;
}

function loginForm(msg) {
  return shell("Acceso", `<form class="login" method="get" action="/panel">
    ${msg ? `<p style="color:#c00;font-weight:600">${esc(msg)}</p>` : ""}
    <p>Escribe tu clave para entrar 💕</p>
    <input name="key" type="password" placeholder="Clave" autofocus>
    <button type="submit">Entrar</button></form>`);
}

// ─── Vista: BANDEJA ──────────────────────────────────────────────
function vistaBandeja(key, role, filtro) {
  const rows = inbox_rows();
  const n = contar(rows);
  const k = encodeURIComponent(key);

  let lista = rows;
  if (filtro === "pendientes") lista = rows.filter(r => r.estado === "pendiente");
  else if (filtro === "esperando") lista = rows.filter(r => r.estado === "esperando");
  else if (filtro === "ia") lista = rows.filter(r => r.atendida_por === "ia");
  else if (filtro === "humano") lista = rows.filter(r => r.atendida_por === "humano");
  else if (filtro === "urgentes") lista = rows.filter(r => r.urgente);

  // Las que llevan más tiempo esperando van primero: nadie se queda en visto.
  lista = lista.slice().sort((a, b) => {
    if (a.estado !== b.estado) return a.estado === "pendiente" ? -1 : 1;
    if (a.estado === "pendiente") return (a.last_in || 0) - (b.last_in || 0);
    return (b.last_seen || 0) - (a.last_seen || 0);
  });

  const tile = (f, num, txt) =>
    `<a class="tile ${filtro === f ? "sel" : ""}" href="/panel?key=${k}&f=${f}"><b>${num}</b><span>${txt}</span></a>`;

  const tiles = `<div class="tiles">
    ${tile("pendientes", n.pendientes, "🔴 Pendientes")}
    ${tile("esperando", n.esperando, "🟡 Esperando clienta")}
    ${tile("ia", n.ia, "🤖 Atiende Claude")}
    ${tile("humano", n.humano, "👤 Atiende humano")}
    ${n.urgentes ? tile("urgentes", n.urgentes, "🚨 Requieren humano") : ""}
    ${tile("todas", rows.length, "Todas")}
  </div>`;

  const items = lista.map(r => {
    const disp = prettyName(r.phone, r.name);
    const prev = (r.last_text || "").replace(/\s+/g, " ").slice(0, 78);
    const tags = (r.tags || "").split(",").map(t => t.trim()).filter(Boolean)
      .slice(0, 3).map(t => `<span class="pill tag">${esc(t)}</span>`).join("");
    const pills =
      (r.urgente ? `<span class="pill urg">🚨 HUMANO</span>` : "") +
      (r.estado === "pendiente"
        ? `<span class="pill rojo">🔴 Pendiente ${esc(hace(r.last_in))}</span>`
        : `<span class="pill amar">🟡 Esperando</span>`) +
      (r.atendida_por === "humano"
        ? `<span class="pill hum">👤 ${esc(r.taken_by || "humano")}</span>`
        : `<span class="pill ia">🤖 Claude</span>`) + tags;
    return `<a class="item" href="/panel/chat?key=${k}&phone=${encodeURIComponent(r.phone)}">
      <span class="time">${esc(fmtTime(r.last_seen))}</span>
      <div class="n">${esc(disp)}</div>
      <div style="margin:5px 0 2px">${pills}</div>
      <div class="p">${esc(prev) || "&nbsp;"}</div></a>`;
  }).join("");

  return shell("Bandeja", `${tiles}
    <p class="muted">${lista.length} conversaciones${filtro && filtro !== "todas" ? " en este filtro" : ""} · las que llevan más tiempo esperando salen primero</p>
    ${items || "<p class='muted'>Nada por aquí ✨</p>"}`, { key, role, activa: "bandeja" });
}

// ─── Vista: CONVERSACIÓN ─────────────────────────────────────────
function vistaChat(phone, key, role, { notice = "", productos = null, q = "" } = {}) {
  const f = ficha(phone);
  const disp = prettyName(phone, f.c.name);
  const k = encodeURIComponent(key);
  const p = encodeURIComponent(phone);
  const esIG = phone.startsWith("ig:");
  const pausado = is_handed_off(phone);

  const msgs = db.prepare(`
    SELECT direction, type, content, timestamp, media_path, source
    FROM messages WHERE phone = ? ORDER BY timestamp ASC LIMIT 1500
  `).all(phone);

  const burbujas = msgs.map(m => {
    const quien = m.direction === "out" ? `out${m.source === "humano" ? " hum" : ""}` : "in";
    let cuerpo = esc(m.content || "");
    if (m.type !== "text" && m.media_path) {
      const url = `/comprobantes/${encodeURIComponent(path.basename(m.media_path))}`;
      cuerpo += m.type === "video"
        ? `<video src="${url}" controls preload="metadata"></video>`
        : `<img src="${url}" alt="foto" loading="lazy">`;
    } else if (m.type !== "text") {
      cuerpo += ` [${esc(m.type)}]`;
    }
    const firma = m.direction === "out" ? (m.source === "humano" ? "👤 " : "🤖 ") : "";
    return `<div class="msg ${quien}">${cuerpo}<div class="meta">${firma}${esc(fmtTime(m.timestamp))}</div></div>`;
  }).join("") + `<div class="clear"></div>`;

  // ── Resumen de IA ──
  const ai = f.ai;
  const aiCard = `<div class="card ai">
    <h3>🤖 Resumen de Claude</h3>
    ${ai ? `<div class="txt">${esc(ai.resumen || "")}</div>
      <div style="margin-top:9px">
        <div class="kv"><span>Intención</span><b>${esc(ai.intencion || "—")}</b></div>
        <div class="kv"><span>Producto</span><b>${esc(ai.producto || "—")}</b></div>
        <div class="kv"><span>Probabilidad de compra</span><b>${esc(ai.probabilidad || "—")}</b></div>
      </div>
      ${ai.necesita_humano ? `<p class="notice err" style="margin-top:9px">🚨 Requiere humano: ${esc(ai.motivo_humano || "revisar")}</p>` : ""}
      ${ai.sugerencia ? `<p class="notice" style="margin-top:9px">💡 ${esc(ai.sugerencia)}</p>` : ""}
      <p class="muted" style="margin:8px 0 0">Analizado ${esc(hace(f.c.panel_ai_at))}</p>`
      : `<p class="muted">Todavía no se ha analizado esta conversación.</p>`}
    <form method="post" action="/panel/analizar">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <button class="ghost big" type="submit">${ai ? "🔄 Volver a analizar" : "✨ Analizar conversación"}</button>
    </form>
  </div>`;

  // ── Ficha de la clienta ──
  const ult = f.ultimo;
  const tagsActuales = (f.c.tags || "").split(",").map(t => t.trim()).filter(Boolean);
  const PRESET = ["Frecuente", "Mayorista", "Interesada", "Reclamo", "VIP"];
  const botonesTag = PRESET.map(t => {
    const on = tagsActuales.includes(t);
    return `<button class="${on ? "" : "grey"}" style="padding:6px 11px;font-size:.78rem" name="tag" value="${esc(t)}">${on ? "✓ " : ""}${esc(t)}</button>`;
  }).join(" ");

  const fichaCard = `<div class="card">
    <h3>👩 Clienta</h3>
    <div style="font-weight:700;font-size:1.05rem">${esc(disp)}</div>
    <div class="muted" style="margin-bottom:8px">${esc(phone.replace(/^whatsapp:/, ""))} · ${esIG ? "Instagram" : "WhatsApp"}</div>
    <div class="kv"><span>Clienta desde</span><b>${esc(fmtTime(f.c.first_seen) || "—")}</b></div>
    <div class="kv"><span>Compras</span><b>${f.compras.n}</b></div>
    <div class="kv"><span>Total gastado</span><b>RD$${rd(f.compras.gastado)}</b></div>
    <div class="kv"><span>Mensajes</span><b>${f.nmsgs}</b></div>
    ${ult ? `<div class="kv"><span>Último pedido</span><b>${esc(ESTADOS_PEDIDO[ult.status] || ult.status)}</b></div>
      <div class="muted" style="margin-top:4px">${esc(productos_de(ult.items) || "—")}${ult.total ? ` · RD$${rd(ult.total)}` : ""}</div>
      ${ult.guia_envio ? `<div class="muted">🚚 ${esc(ult.empresa_envio || "")} guía ${esc(ult.guia_envio)}</div>` : ""}`
      : `<p class="muted" style="margin:8px 0 0">Sin pedidos registrados.</p>`}
    ${f.abiertos ? `<p class="notice err" style="margin-top:9px">⚠️ ${f.abiertos} pedido(s) abierto(s) sin cerrar</p>` : ""}
  </div>

  <div class="card">
    <h3>🏷️ Etiquetas</h3>
    <form method="post" action="/panel/etiqueta">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <div class="row">${botonesTag}</div>
    </form>
  </div>

  <div class="card">
    <h3>📝 Notas del equipo</h3>
    <form method="post" action="/panel/nota">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <textarea name="notes" rows="4" placeholder="Ej: le gustan las pelucas largas onduladas…">${esc(f.c.notes || "")}</textarea>
      <button class="ghost big" type="submit">Guardar nota</button>
    </form>
  </div>

  ${f.c.summary ? `<div class="card"><h3>🧠 Ficha que recuerda el bot</h3>
    <div class="muted" style="white-space:pre-wrap">${esc(f.c.summary)}</div></div>` : ""}`;

  // ── Control IA / humano ──
  const control = esIG ? "" : `<div class="card">
    <h3>Quién atiende</h3>
    ${pausado
      ? `<p class="notice">👤 <b>${esc(f.c.taken_by || "Humano")}</b> está atendiendo. Claude está en pausa con esta clienta.</p>
         <form method="post" action="/panel/devolver">
           <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
           <button class="grey big" type="submit">🤖 Devolver a Claude</button></form>`
      : `<p class="muted">🤖 Claude está atendiendo a esta clienta.</p>
         <form method="post" action="/panel/tomar">
           <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
           <button class="big" type="submit">👤 TOMAR CONVERSACIÓN</button></form>
         <p class="muted" style="margin:6px 0 0">Pausa a Claude 2 horas para que no respondan los dos a la vez.</p>`}
  </div>`;

  // ── Catálogo rápido ──
  const listaProd = (productos || []).map(pr => {
    const foto = pr.media_url && /\.(jpg|jpeg|png|webp)$/i.test(pr.media_url) ? pr.media_url : "";
    return `<div class="prod">
      ${foto ? `<img src="${esc(foto)}" alt="" loading="lazy">` : `<div style="width:56px;height:56px;border-radius:9px;background:#f0f0f4"></div>`}
      <div class="info"><b>${esc(pr.nombre)}</b>RD$${rd(pr.precio_detalle)}${pr.precio_mayor ? ` · mayor RD$${rd(pr.precio_mayor)}` : ""}</div>
      <form method="post" action="/panel/enviar-producto">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
        <input type="hidden" name="codigo" value="${esc(pr.codigo)}">
        <button type="submit" style="padding:8px 12px;font-size:.8rem">Enviar</button>
      </form></div>`;
  }).join("");

  const catalogo = esIG ? "" : `<div class="card">
    <h3>🛍️ Catálogo rápido</h3>
    <form method="get" action="/panel/chat">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <div class="row">
        <input type="search" name="q" value="${esc(q)}" placeholder="peluca ondulada 26, closure, ofertas…" style="flex:1;min-width:160px">
        <button type="submit">Buscar</button>
      </div>
    </form>
    ${productos ? (listaProd || `<p class="muted" style="margin-top:8px">No encontré nada con «${esc(q)}».</p>`) : ""}
    <p class="muted" style="margin:8px 0 0">Escribe <b>ofertas</b> para ver lo que está en oferta. El precio siempre le llega por texto.</p>
  </div>`;

  const responder = esIG ? `<p class="muted">Los mensajes de Instagram todavía no se responden desde aquí.</p>` : `
    <form class="card" method="post" action="/panel/reply" enctype="multipart/form-data">
      <h3>💬 Responder como Winny</h3>
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="phone" value="${esc(phone)}">
      <textarea name="msg" rows="3" placeholder="Escribe tu mensaje…"></textarea>
      <input type="file" name="media" accept="image/*,video/*" style="margin-top:8px">
      <div class="row">
        <label style="flex:1;font-size:.82rem;color:var(--soft)">
          <input type="checkbox" name="pausar" value="1" ${pausado ? "checked" : ""}> seguir atendiendo yo (pausa Claude)</label>
        <button type="submit">Enviar 💬</button>
      </div>
      <p class="muted" style="margin:8px 0 0">Si su último mensaje tiene más de 24 h, WhatsApp puede rechazar el envío.</p>
    </form>`;

  return shell(disp, `
    <a href="/panel?key=${k}">← Bandeja</a>
    <h2 style="margin:8px 0 2px">${esc(disp)}</h2>
    <p class="muted" style="margin:0 0 10px">${esc(phone.replace(/^whatsapp:/, ""))} · ${msgs.length} mensajes · último ${esc(hace(f.c.last_seen))}</p>
    ${notice}
    <div class="chatgrid">
      <div>
        ${control}
        <div class="chat">${burbujas || "<p class='muted'>Sin mensajes.</p>"}</div>
        ${responder}
        ${catalogo}
      </div>
      <div>${aiCard}${fichaCard}</div>
    </div>`, { key, role, activa: "bandeja" });
}

// ─── Vista: DASHBOARD (solo jefa) ────────────────────────────────
function vistaDashboard(key, role) {
  const desde = inicioDelDia();
  const owner = ownerDigits();
  const noOwner = `AND replace(replace(phone,'whatsapp:',''),'+','') != '${owner}'`;

  const q = (sql, ...args) => { try { return db.prepare(sql).get(...args) || {}; } catch { return {}; } };

  const convos = q(`SELECT COUNT(DISTINCT phone) AS n FROM messages WHERE timestamp >= ? ${noOwner}`, desde).n || 0;
  const entrantes = q(`SELECT COUNT(*) AS n FROM messages WHERE direction='in' AND timestamp >= ? ${noOwner}`, desde).n || 0;
  const porIA = q(`SELECT COUNT(DISTINCT phone) AS n FROM messages WHERE direction='out' AND timestamp >= ?
                   AND (source IS NULL OR source != 'humano') ${noOwner}`, desde).n || 0;
  const porHumano = q(`SELECT COUNT(DISTINCT phone) AS n FROM messages WHERE direction='out' AND timestamp >= ?
                   AND source = 'humano' ${noOwner}`, desde).n || 0;
  const nuevas = q(`SELECT COUNT(*) AS n FROM contacts WHERE first_seen >= ? ${noOwner}`, desde).n || 0;
  const pedidosHoy = q("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS monto FROM orders WHERE created_at >= ?", desde);
  const vendidoHoy = q(`SELECT COALESCE(SUM(total),0) AS monto FROM orders
                        WHERE updated_at >= ? AND status IN ('paid','shipped','delivered')`, desde).monto || 0;
  const porConfirmar = q("SELECT COUNT(*) AS n FROM orders WHERE status='awaiting_verification'").n || 0;
  const porEnviar = q("SELECT COUNT(*) AS n FROM orders WHERE status='paid'").n || 0;

  const rows = inbox_rows();
  const n = contar(rows);
  const conv = convos ? Math.round(((pedidosHoy.n || 0) / convos) * 100) : 0;

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;

  // Las que llevan más rato esperando: la lista de "apágale el fuego a esto ya".
  const urgentes = rows.filter(r => r.estado === "pendiente")
    .sort((a, b) => (a.last_in || 0) - (b.last_in || 0)).slice(0, 8)
    .map(r => `<a class="item" href="/panel/chat?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(r.phone)}">
        <span class="time">${esc(hace(r.last_in))}</span>
        <div class="n">${esc(prettyName(r.phone, r.name))}</div>
        <div class="p">${esc((r.last_text || "").replace(/\s+/g, " ").slice(0, 70))}</div></a>`).join("");

  return shell("Números de hoy", `
    <h2 style="margin:4px 0 10px">📊 Hoy</h2>
    <div class="tiles">
      ${t(convos, "💬 Conversaciones")}
      ${t(entrantes, "📨 Mensajes recibidos")}
      ${t(porIA, "🤖 Atendió Claude")}
      ${t(porHumano, "👤 Atendió humano")}
      ${t(nuevas, "👥 Clientas nuevas")}
    </div>
    <h3 style="margin:16px 0 8px">Ventas</h3>
    <div class="tiles">
      ${t(pedidosHoy.n || 0, "🛒 Pedidos creados")}
      ${t("RD$" + rd(vendidoHoy), "💰 Cobrado hoy")}
      ${t(conv + "%", "🎯 Conversación → pedido")}
    </div>
    <h3 style="margin:16px 0 8px">Necesita tu atención</h3>
    <div class="tiles">
      ${t(n.pendientes, "🔴 Clientas esperando")}
      ${t(porConfirmar, "⚠️ Pagos por confirmar")}
      ${t(porEnviar, "📦 Pedidos por enviar")}
      ${t(n.humano, "👤 En manos humanas")}
    </div>
    ${urgentes ? `<h3 style="margin:16px 0 8px">⏱️ Llevan más tiempo esperando</h3>${urgentes}` : ""}
    <p class="muted" style="margin-top:14px">Los números son de hoy en horario de Santo Domingo. «Atendió Claude» / «Atendió humano» cuenta clientas distintas, no mensajes.</p>
  `, { key, role, activa: "dash" });
}

// ─── Rutas ───────────────────────────────────────────────────────
export function mount_panel(app) {
  const guard = (req, res) => {
    if (!ADMIN_KEY) { res.status(503).send("El panel no está configurado (falta ADMIN_KEY)."); return null; }
    const key = (req.query.key ?? req.body?.key ?? "").toString();
    const role = key_role(key);
    if (!role) {
      res.status(key ? 401 : 200).send(loginForm(key ? "Clave incorrecta" : ""));
      return null;
    }
    return { key, role };
  };

  const volver = (key, phone, extra = "") =>
    `/panel/chat?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(phone || "")}${extra}`;

  app.get("/panel", (req, res) => {
    const g = guard(req, res); if (!g) return;
    res.send(vistaBandeja(g.key, g.role, (req.query.f || "").toString()));
  });

  app.get("/panel/chat", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.query.phone || "").toString();
    if (!phone) return res.redirect(`/panel?key=${encodeURIComponent(g.key)}`);

    let notice = "";
    if (req.query.ok) notice = `<div class="notice">✅ ${esc(String(req.query.ok))}</div>`;
    if (req.query.err) notice = `<div class="notice err">⚠️ ${esc(String(req.query.err))}</div>`;

    // Búsqueda del catálogo rápido (no envía nada, solo muestra).
    const q = (req.query.q || "").toString().trim();
    let productos = null;
    if (q) {
      try {
        productos = /^ofertas?$/i.test(q) ? (await get_offers()).slice(0, 8) : await find_products(q, 8);
      } catch (e) {
        productos = [];
        logger.error({ err: e.message }, "Panel: error buscando en el catálogo");
      }
    }
    res.send(vistaChat(phone, g.key, g.role, { notice, productos, q }));
  });

  app.get("/panel/dashboard", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (g.role !== "jefa") return res.status(403).send(shell("Sin acceso",
      `<div class="card"><p>Esta sección es solo para Winny 💕</p>
       <a href="/panel?key=${encodeURIComponent(g.key)}">← Volver a la bandeja</a></div>`, { key: g.key, role: g.role }));
    res.send(vistaDashboard(g.key, g.role));
  });

  // ── Responder ──
  app.post("/panel/reply", upload.single("media"), async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const { phone, msg, pausar } = req.body || {};
    const text = (msg || "").trim();
    const file = req.file || null;
    if (!phone || (!text && !file)) {
      return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("Escribe un mensaje o adjunta una foto.")));
    }
    try {
      let sid;
      if (file) {
        const media_url = `${config.public_base_url}/comprobantes/${file.filename}`;
        sid = await send_image(phone, media_url, text);
      } else {
        sid = await send_text(phone, text);
      }
      if (!sid) return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("WhatsApp rechazó el envío (¿pasaron 24 h?).")));
      save_out(phone, {
        type: file ? (/^video\//.test(file.mimetype) ? "video" : "image") : "text",
        content: text || "[foto/video]",
        media_path: file ? file.path : null,
        sid
      });
      if (pausar === "1") { set_handoff(phone, 120); mark_human_reply(phone); }
      else { clear_handoff(phone); mark_human_reply(phone); }
      db.prepare("UPDATE contacts SET taken_by = COALESCE(taken_by, ?) WHERE phone = ?").run(g.role, phone);
      logger.info({ phone, rol: g.role, media: !!file }, "💬 Panel v2: respuesta enviada");
      return res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Mensaje enviado.")));
    } catch (e) {
      logger.error({ err: e.message, phone }, "Panel v2: error enviando");
      return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("Error: " + e.message)));
    }
  });

  // ── Tomar / devolver la conversación ──
  app.post("/panel/tomar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    set_handoff(phone, 120);
    mark_human_reply(phone);
    db.prepare("UPDATE contacts SET taken_by = ? WHERE phone = ?").run(g.role, phone);
    logger.info({ phone, rol: g.role }, "👤 Panel v2: conversación tomada por un humano");
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("La estás atendiendo tú. Claude no le escribirá.")));
  });

  app.post("/panel/devolver", (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    clear_handoff(phone);
    db.prepare("UPDATE contacts SET taken_by = NULL WHERE phone = ?").run(phone);
    logger.info({ phone, rol: g.role }, "🤖 Panel v2: conversación devuelta a Claude");
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Claude vuelve a atenderla.")));
  });

  // ── Notas y etiquetas ──
  app.post("/panel/nota", (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    db.prepare("UPDATE contacts SET notes = ? WHERE phone = ?").run((req.body?.notes || "").toString().slice(0, 4000), phone);
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Nota guardada.")));
  });

  app.post("/panel/etiqueta", (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    const tag = (req.body?.tag || "").toString().trim();
    if (tag) {
      const row = db.prepare("SELECT tags FROM contacts WHERE phone = ?").get(phone);
      const actuales = (row?.tags || "").split(",").map(t => t.trim()).filter(Boolean);
      const nuevas = actuales.includes(tag) ? actuales.filter(t => t !== tag) : [...actuales, tag];
      db.prepare("UPDATE contacts SET tags = ? WHERE phone = ?").run(nuevas.join(", "), phone);
    }
    res.redirect(volver(g.key, phone));
  });

  // ── Análisis de IA ──
  app.post("/panel/analizar", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    try {
      const data = await analizar(phone);
      return res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent(data ? "Conversación analizada." : "No hay suficiente conversación para analizar.")));
    } catch (e) {
      logger.error({ err: e.message, phone }, "Panel v2: error analizando");
      return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("No pude analizar: " + e.message)));
    }
  });

  // ── Enviar producto del catálogo ──
  app.post("/panel/enviar-producto", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    const codigo = (req.body?.codigo || "").toString();
    try {
      const p = await get_by_code(codigo);
      if (!p) return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("No encontré ese producto.")));

      const raw = (p.media_url && p.media_url.startsWith("http")) ? p.media_url : null;
      const esLinkDePagina = raw && /(instagram\.com|tiktok\.com|facebook\.com|fb\.watch|youtu\.?be)/i.test(raw);
      const lineas = [`🛍️ *${p.nombre}*`, `💵 RD$${rd(p.precio_detalle)}`];
      if (p.precio_mayor) lineas.push(`📦 Por ${p.cant_mayor || "mayor"}: RD$${rd(p.precio_mayor)} c/u`);
      if (p.colores) lineas.push(`🎨 Colores: ${p.colores}`);
      if (p.oferta) lineas.push("🔥 ¡EN OFERTA!");
      if (esLinkDePagina) lineas.push(`🎥 Míralo aquí: ${raw}`);
      const caption = lineas.join("\n");

      const sid = await send_text(phone, caption);
      if (!sid) return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("WhatsApp rechazó el envío (¿pasaron 24 h?).")));
      save_out(phone, { type: "text", content: caption, sid });

      if (raw && !esLinkDePagina) {
        try {
          const isid = await send_image(phone, raw, "");
          if (isid) save_out(phone, { type: "image", content: `[foto ${p.nombre}]`, sid: isid });
        } catch { /* la foto es un extra: el precio ya llegó por texto */ }
      }
      mark_human_reply(phone);
      logger.info({ phone, producto: p.nombre, rol: g.role }, "🛍️ Panel v2: producto enviado");
      return res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent(`Enviado: ${p.nombre}`)));
    } catch (e) {
      logger.error({ err: e.message, phone }, "Panel v2: error enviando producto");
      return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("Error: " + e.message)));
    }
  });

  logger.info("🖥️  Panel v2 montado en /panel");
}
