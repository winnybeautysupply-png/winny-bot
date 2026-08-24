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
import fs from "fs";
import path from "path";
import multer from "multer";
import db, {
  set_handoff, clear_handoff, is_handed_off, mark_human_reply, get_open_orders, set_shipping
} from "./db.js";
import { send_text, send_image } from "./whatsapp.js";
import { find_products, get_offers, get_by_code, get_catalog } from "./catalog.js";
import {
  todo_el_stock, mover, ajustar, resumen_inventario, por_acabarse, existencia, olvidar
} from "./inventario.js";
import {
  list_employees, create_employee, set_active, regenerate_key, find_by_key, productividad, delete_employee,
  PERMISOS, set_permisos
} from "./team.js";
import {
  analizar, start_supervisor, supervisor_encendido, set_setting, analisis_hoy, estado_supervisor
} from "./supervisor.js";
import {
  crear_apartado, abonar, cambiar_estado, ampliar_plazo, borrar_apartado, get_apartado,
  apartados_de, todos_apartados, pagos_de, resumen_apartados, phones_con_apartado,
  plazo_dias, start_layaway_poller
} from "./apartados.js";
import {
  METODOS, categorias, set_categorias, registrar_venta, anular_venta,
  ventas_del_dia, cuadre, borrar_venta_anulada,
  CATEGORIAS_GASTO, registrar_gasto, borrar_gasto, gastos_del_dia, total_gastos,
  efectivo_esperado, cierre_de_hoy, cerrar_caja, cierres_recientes
} from "./ventas.js";
import {
  audiencia, crear_campana, campana_activa, listar_campanas, conteo,
  cambiar_estado_campana, start_campaign_poller, enviar_prueba, respondieron_lista
} from "./campanas.js";
import {
  TABLAS, exportar_csv, copiar_base, conteos, respaldos_guardados,
  fecha_archivo, start_backup_poller
} from "./respaldo.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

// ─── Migraciones propias del panel (no tocan el resto del bot) ───
for (const col of [
  "notes TEXT",              // notas del equipo sobre la clienta
  "tags TEXT",               // etiquetas separadas por coma
  "panel_ai TEXT",           // último análisis de IA (JSON)
  "panel_ai_at INTEGER DEFAULT 0",
  "taken_by TEXT",           // quién tomó la conversación (jefa/empleada)
  "cumple TEXT"              // cumpleaños de la clienta (AAAA-MM-DD)
]) {
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${col}`); } catch { /* ya existe */ }
}
// Marca de QUIÉN mandó cada mensaje saliente: null/"ia" = el bot, "humano" = el panel.
try { db.exec("ALTER TABLE messages ADD COLUMN source TEXT"); } catch { /* ya existe */ }

const ADMIN_KEY = process.env.ADMIN_KEY || "";
const EMPLOYEE_KEY = process.env.EMPLOYEE_KEY || ""; // clave compartida vieja (sigue sirviendo)

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
// Quién es la dueña de esta clave: la jefa, una empleada con cuenta propia,
// o la clave compartida vieja (que se mantiene para no dejar a nadie fuera).
function quien_es(k) {
  if (ADMIN_KEY && k === ADMIN_KEY) return { role: "jefa", nombre: "Winny", permisos: ["caja", "apartados"] };
  const emp = find_by_key(k);
  if (emp) return {
    role: "empleada", nombre: emp.nombre, id: emp.id,
    permisos: String(emp.permisos || "").split(",").map(s => s.trim()).filter(Boolean)
  };
  if (EMPLOYEE_KEY && k === EMPLOYEE_KEY) return { role: "empleada", nombre: "Empleada", permisos: ["caja", "apartados"] };
  return null;
}

// ¿Esta persona puede entrar aquí? La jefa siempre; la empleada solo si se lo dieron.
function puede(g, permiso) {
  return g.role === "jefa" || (g.permisos || []).includes(permiso);
}

// ─── Sesión con cookie ───────────────────────────────────────────
// La app instalada en el celular abre en /panel SIN clave en el enlace.
// Por eso, la primera vez que entra con su clave, se guarda en una cookie
// (90 días, HttpOnly, solo por HTTPS). "Salir" la borra.
const COOKIE = "wpk";

function cookie_key(req) {
  const raw = req.headers?.cookie || "";
  const m = raw.match(/(?:^|;\s*)wpk=([^;]+)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
}

function guardar_cookie(res, key) {
  res.setHeader("Set-Cookie",
    `${COOKIE}=${encodeURIComponent(key)}; Path=/panel; Max-Age=${90 * 24 * 3600}; HttpOnly; Secure; SameSite=Lax`);
}

function borrar_cookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/panel; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
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

// ¿Hoy cumple años? Se compara solo mes y día (el año da igual).
function esCumpleHoy(cumple) {
  if (!cumple || cumple.length < 5) return false;
  const hoy = new Date(Date.now() - 4 * 3600000); // Santo Domingo
  const p = n => String(n).padStart(2, "0");
  return cumple.slice(-5) === `${p(hoy.getUTCMonth() + 1)}-${p(hoy.getUTCDate())}`;
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
function save_out(phone, { type = "text", content = "", media_path = null, sid = null, source = "humano", agent = null }) {
  db.prepare(`INSERT INTO messages (phone, direction, type, content, media_path, wa_message_id, timestamp, source, agent)
              VALUES (?, 'out', ?, ?, ?, ?, ?, ?, ?)`)
    .run(phone, type, content || null, media_path, sid, Date.now(), source, agent);
}

// ─── Consultas de la bandeja ─────────────────────────────────────

// Una fila por clienta con todo lo que la bandeja necesita para pintar el estado.
function inbox_rows(limit = 300) {
  const owner = ownerDigits();
  const rows = db.prepare(`
    SELECT c.phone AS phone, c.name AS name, c.last_seen AS last_seen,
           c.handed_off_until AS handoff, c.tags AS tags, c.panel_ai AS panel_ai,
           c.taken_by AS taken_by, c.assigned_to AS assigned_to, c.cumple AS cumple,
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
                               panel_ai, panel_ai_at, taken_by, handed_off_until, assigned_to, cumple
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
  // Puntos de fidelidad: 1 punto por cada RD$100 que ha gastado.
  const puntos = Math.floor((Number(compras.gastado) || 0) / 100);
  // De dónde es (lo dijo al hacer un pedido).
  const zona = db.prepare(`SELECT provincia, ubicacion, delivery_address FROM orders
                           WHERE phone = ? AND (provincia IS NOT NULL OR delivery_address IS NOT NULL)
                           ORDER BY created_at DESC LIMIT 1`).get(phone) || {};
  const lugar = zona.provincia || zona.ubicacion ||
    (zona.delivery_address ? String(zona.delivery_address).slice(0, 40) : "");
  return { c, compras, ultimo, abiertos, nmsgs, ai, puntos, lugar };
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

// ─── HTML ────────────────────────────────────────────────────────
function shell(title, inner, { key = "", role = "", nombre = "", activa = "", permisos = [], refresco = 0 } = {}) {
  const tiene = p => role === "jefa" || permisos.includes(p);
  const k = encodeURIComponent(key);
  const nav = key ? `
    <nav class="nav">
      <a class="${activa === "bandeja" ? "on" : ""}" href="/panel?key=${k}">📥 Bandeja</a>
      ${role === "empleada" ? `<a class="${activa === "mias" ? "on" : ""}" href="/panel?key=${k}&f=mias">👩 Mías</a>` : ""}
      ${tiene("caja") ? `<a class="${activa === "caja" ? "on" : ""}" href="/panel/caja?key=${k}">🧾 Caja</a>` : ""}
      ${tiene("apartados") ? `<a class="${activa === "apartados" ? "on" : ""}" href="/panel/apartados?key=${k}">🔖 Apartados</a>` : ""}
      ${role === "jefa" ? `<a class="${activa === "dash" ? "on" : ""}" href="/panel/dashboard?key=${k}">📊 Números</a>` : ""}
          ${tiene("caja") ? `<a class="${activa === "inventario" ? "on" : ""}" href="/panel/inventario?key=${k}">📦 Inventario</a>` : ""}
      ${role === "jefa" ? `<a class="${activa === "campanas" ? "on" : ""}" href="/panel/campanas?key=${k}">📣 Campañas</a>` : ""}
      ${role === "jefa" ? `<a class="${activa === "equipo" ? "on" : ""}" href="/panel/equipo?key=${k}">👥 Equipo</a>` : ""}
      ${role === "jefa" ? `<a class="${activa === "pedidos" ? "on" : ""}" href="/panel/pedidos?key=${k}">🧾 Pedidos</a>` : ""}
      ${role === "jefa" ? `<a class="${activa === "respaldo" ? "on" : ""}" href="/panel/respaldo?key=${k}">💾 Respaldo</a>` : ""}
      <a class="${activa === "app" ? "on" : ""}" href="/panel/app?key=${k}">📲 App</a>
      <a href="/panel/salir">🚪 Salir</a>
    </nav>` : "";

  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="manifest" href="/panel/manifest.webmanifest">
<meta name="theme-color" content="#c2185b">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Winny Panel">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/panel/icono.jpg">
<link rel="icon" href="/panel/icono.jpg">
<style>
:root{--pink:#c2185b;--pink-soft:#fce4ec;--ink:#232326;--soft:#6b7280;--line:#e7e7ec;--bg:#f4f5f7}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:0;background:var(--bg);color:var(--ink)}
header{background:var(--pink);color:#fff;padding:12px 16px;font-weight:700;position:sticky;top:0;z-index:9;
  display:flex;justify-content:space-between;align-items:center;gap:10px}
header .rol{font-weight:500;font-size:.78rem;opacity:.9;background:rgba(255,255,255,.18);padding:3px 9px;border-radius:20px}
/* Los botones del menú DAN LA VUELTA en vez de salirse de la pantalla:
   antes, en el celular, "Campañas" y los de más allá quedaban escondidos. */
.nav{display:flex;flex-wrap:wrap;gap:6px;background:#fff;border-bottom:1px solid var(--line);
  padding:8px 12px;position:sticky;top:44px;z-index:8}
.nav a{white-space:nowrap;color:var(--soft);text-decoration:none;font-size:.85rem;font-weight:600;
  padding:7px 12px;border-radius:20px;background:#f5f5f7}
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
.dia{clear:both;text-align:center;margin:14px 0 6px;font-size:.72rem;color:#7a828e;font-weight:700}
.dia:before,.dia:after{content:"";display:inline-block;width:22%;height:1px;background:var(--line);
  vertical-align:middle;margin:0 8px}
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
<header><span>🌸 Winny — Centro de atención</span>${role ? `<span class="rol">${esc(nombre || role)}</span>` : ""}</header>
${nav}
<div class="wrap">${inner}</div>
<script>
if('serviceWorker' in navigator){navigator.serviceWorker.register('/panel/sw.js').catch(function(){})}
(function(){
  // La app se refresca sola para que los mensajes nuevos aparezcan sin tener
  // que hacer nada. PERO nunca mientras está escribiendo, ni con un menú
  // abierto: eso le borraría lo que lleva escrito.
  var segundos = ${refresco};
  if (!segundos) return;
  var t = null;
  function ocupada(){
    var a = document.activeElement;
    if (a && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName)) return true;
    if (document.querySelectorAll("details[open]").length) return true;
    // Si se fue para arriba a leer algo viejo, tampoco le movemos la pantalla.
    var falta = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    return falta > 250;
  }
  function programar(){
    clearTimeout(t);
    t = setTimeout(function(){
      if (document.hidden || ocupada()) { programar(); return; }
      location.reload();
    }, segundos * 1000);
  }
  document.addEventListener("visibilitychange", programar);
  programar();
})();
</script>
</body></html>`;
}

function loginForm(msg) {
  return shell("Acceso", `<form class="login" method="get" action="/panel">
    ${msg ? `<p style="color:#c00;font-weight:600">${esc(msg)}</p>` : ""}
    <p>Escribe tu clave para entrar 💕</p>
    <input name="key" type="password" placeholder="Clave" autofocus>
    <button type="submit">Entrar</button></form>`);
}

// ─── Vista: BANDEJA ──────────────────────────────────────────────
function vistaBandeja(key, role, nombre, filtro, buscar = "", permisos = []) {
  const rows = inbox_rows();
  const n = contar(rows);
  const k = encodeURIComponent(key);
  const mias = rows.filter(r => r.assigned_to && r.assigned_to === nombre).length;
  const conApartado = phones_con_apartado();
  // Las que respondieron la campaña: son las más calientes del día y no se
  // pueden quedar perdidas entre 300 conversaciones.
  let respondieronCampana = new Set();
  try {
    const ca = campana_activa();
    if (ca) respondieronCampana = new Set(respondieron_lista(ca.id).map(x => x.phone));
  } catch { /* sin campaña */ }

  let lista = rows;
  if (buscar) {
    const b = buscar.toLowerCase();
    lista = rows.filter(r =>
      (r.name || "").toLowerCase().includes(b) ||
      (r.phone || "").includes(b.replace(/\D/g, "")) ||
      (r.last_text || "").toLowerCase().includes(b));
  }
  else if (filtro === "campana") lista = rows.filter(r => respondieronCampana.has(r.phone));
  else if (filtro === "mias") lista = rows.filter(r => r.assigned_to === nombre);
  else if (filtro === "pendientes") lista = rows.filter(r => r.estado === "pendiente");
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
    ${respondieronCampana.size ? tile("campana", respondieronCampana.size, "💬 Respondieron campaña") : ""}
    ${mias ? tile("mias", mias, "👩 Mías") : ""}
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
        : `<span class="pill ia">🤖 Claude</span>`) +
      (r.assigned_to && r.assigned_to !== r.taken_by ? `<span class="pill tag">👩 ${esc(r.assigned_to)}</span>` : "") +
      (respondieronCampana.has(r.phone) ? `<span class="pill hum">💬 Respondió la campaña</span>` : "") +
      (esCumpleHoy(r.cumple) ? `<span class="pill amar">🎂 Cumple hoy</span>` : "") +
      (conApartado.has(r.phone)
        ? `<span class="pill ${conApartado.get(r.phone).vencido ? "urg" : "amar"}">🔖 ${conApartado.get(r.phone).vencido ? "Apartado vencido" : `Apartado: faltan RD$${rd(conApartado.get(r.phone).balance)}`}</span>`
        : "") + tags;
    return `<a class="item" href="/panel/chat?key=${k}&phone=${encodeURIComponent(r.phone)}">
      <span class="time">${esc(fmtTime(r.last_seen))}</span>
      <div class="n">${esc(disp)}</div>
      <div style="margin:5px 0 2px">${pills}</div>
      <div class="p">${esc(prev) || "&nbsp;"}</div></a>`;
  }).join("");

  const buscador = `<form method="get" action="/panel" class="row" style="margin:0 0 10px">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="search" name="buscar" value="${esc(buscar)}" placeholder="Buscar clienta por nombre o teléfono…" style="flex:1;min-width:170px">
      <button type="submit">Buscar</button>
      ${buscar ? `<a class="pill tag" href="/panel?key=${k}">✕ quitar</a>` : ""}
    </form>`;

  return shell("Bandeja", `${buscador}${buscar ? "" : tiles}
    <p class="muted">${lista.length} conversaciones${buscar ? ` con «${esc(buscar)}»` : (filtro && filtro !== "todas" ? " en este filtro" : "")}${buscar ? "" : " · las que llevan más tiempo esperando salen primero"}</p>
    ${items || "<p class='muted'>Nada por aquí ✨</p>"}`,
    { key, role, nombre, permisos, refresco: 30, activa: filtro === "mias" ? "mias" : (filtro === "campana" ? "bandeja" : "bandeja") });
}

// ─── Vista: CONVERSACIÓN ─────────────────────────────────────────
// "Hoy" / "Ayer" / "23 de agosto de 2026" — para no perderse en el chat.
function diaEtiqueta(ts) {
  const hoy = inicioDelDia();
  if (ts >= hoy) return "Hoy";
  if (ts >= hoy - 86400000) return "Ayer";
  try {
    return new Date(ts).toLocaleDateString("es-DO",
      { timeZone: "America/Santo_Domingo", day: "numeric", month: "long", year: "numeric" });
  } catch { return ""; }
}

function vistaChat(phone, key, role, nombre, { notice = "", productos = null, q = "", buscar = "", todos = false, permisos = [] } = {}) {
  const f = ficha(phone);
  const disp = prettyName(phone, f.c.name);
  const k = encodeURIComponent(key);
  const p = encodeURIComponent(phone);
  const esIG = phone.startsWith("ig:");
  const pausado = is_handed_off(phone);

  // Por defecto solo los ÚLTIMOS 60 mensajes: abrir una conversación de 800
  // mensajes desde el principio era inservible. Lo viejo se pide aparte.
  const total_msgs = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE phone = ?").get(phone)?.n || 0;
  const msgs = buscar
    ? db.prepare(`SELECT direction, type, content, timestamp, media_path, source, agent
                  FROM messages WHERE phone = ? AND content LIKE ?
                  ORDER BY timestamp DESC LIMIT 100`).all(phone, `%${buscar}%`).reverse()
    : db.prepare(`SELECT direction, type, content, timestamp, media_path, source, agent
                  FROM messages WHERE phone = ?
                  ORDER BY timestamp DESC LIMIT ?`).all(phone, todos ? 2000 : 60).reverse();

  let dia_actual = "";
  const burbujas = msgs.map(m => {
    let sep = "";
    const d = diaEtiqueta(m.timestamp);
    if (d !== dia_actual) { dia_actual = d; sep = `<div class="dia">${esc(d)}</div>`; }

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
    const firma = m.direction === "out"
      ? (m.source === "humano" ? `👤 ${esc(m.agent || "")} ` : "🤖 ")
      : "";
    const hora = fmtTime(m.timestamp).split(", ")[1] || fmtTime(m.timestamp);
    return `${sep}<div class="msg ${quien}">${cuerpo}<div class="meta">${firma}${esc(hora)}</div></div>`;
  }).join("") + `<div class="clear"></div><div id="fin"></div>`;

  // Cabecera del chat: buscar dentro de la conversación y traer lo viejo.
  const herramientas = `<form method="get" action="/panel/chat" class="row" style="margin-bottom:8px">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <input type="search" name="buscar" value="${esc(buscar)}" placeholder="Buscar en esta conversación…" style="flex:1;min-width:150px">
      <button class="ghost" type="submit">Buscar</button>
      ${buscar ? `<a class="pill tag" href="/panel/chat?key=${k}&phone=${p}">✕ quitar</a>` : ""}
    </form>
    ${buscar
      ? `<p class="muted">${msgs.length} mensaje(s) con «${esc(buscar)}» · <a href="/panel/chat?key=${k}&phone=${p}">ver la conversación completa</a></p>`
      : (total_msgs > msgs.length
        ? `<p class="muted" style="text-align:center"><a href="/panel/chat?key=${k}&phone=${p}&todos=1">⬆️ Ver los ${total_msgs - msgs.length} mensajes anteriores</a></p>`
        : "")}`;

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
      ${ai.consejo_equipo ? `<p class="notice" style="margin-top:9px;background:#fff6e0;border-color:#f3e2b3;color:#7a5a00">🕵️ Consejo: ${esc(ai.consejo_equipo)}</p>` : ""}
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
    <div class="muted" style="margin-bottom:8px">${esc(phone.replace(/^whatsapp:/, ""))} · ${esIG ? "Instagram" : "WhatsApp"}${f.lugar ? ` · 📍 ${esc(f.lugar)}` : ""}</div>
    ${esCumpleHoy(f.c.cumple) ? `<p class="notice">🎂 ¡Hoy es su cumpleaños!</p>` : ""}
    <div class="kv"><span>Clienta desde</span><b>${esc(fmtTime(f.c.first_seen) || "—")}</b></div>
    <div class="kv"><span>Compras</span><b>${f.compras.n}</b></div>
    <div class="kv"><span>Total gastado</span><b>RD$${rd(f.compras.gastado)}</b></div>
    <div class="kv"><span>⭐ Puntos</span><b>${rd(f.puntos)}</b></div>
    <div class="kv"><span>Mensajes</span><b>${f.nmsgs}</b></div>
    <form method="post" action="/panel/cumple" class="row" style="margin-top:8px">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <span class="muted" style="flex:1">🎂 Cumpleaños</span>
      <input type="date" name="cumple" value="${esc(f.c.cumple || "")}" style="flex:1;min-width:135px;padding:8px;border-radius:9px;border:1px solid #ccd0d6">
      <button class="ghost" type="submit" style="padding:8px 12px;font-size:.78rem">Guardar</button>
    </form>
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

  ${apartadosCard(phone, key)}

  ${f.c.summary ? `<div class="card"><h3>🧠 Ficha que recuerda el bot</h3>
    <div class="muted" style="white-space:pre-wrap">${esc(f.c.summary)}</div></div>` : ""}`;

  // ── A quién le toca esta clienta ──
  const equipo = list_employees(false);
  const asignada = f.c.assigned_to || "";
  const asignar = `<form method="post" action="/panel/asignar" style="margin-top:10px">
      <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
      <div class="row">
        <select name="quien" style="flex:1;min-width:140px;padding:9px;border-radius:10px;border:1px solid #ccd0d6">
          <option value="">— sin asignar —</option>
          ${["Winny", ...equipo.map(e => e.nombre)].map(nm =>
            `<option value="${esc(nm)}" ${asignada === nm ? "selected" : ""}>${esc(nm)}</option>`).join("")}
        </select>
        <button class="ghost" type="submit">Asignar</button>
      </div></form>`;

  // ── Control IA / humano ──
  const control = esIG ? "" : `<div class="card">
    <h3>Quién atiende</h3>
    ${asignada ? `<p class="muted" style="margin:0 0 8px">👩 Asignada a <b>${esc(asignada)}</b></p>` : ""}
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
    ${asignar}
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
        ${herramientas}
        <div class="chat">${burbujas || "<p class='muted'>Sin mensajes.</p>"}</div>
        ${responder}
        ${catalogo}
      </div>
      <div>${aiCard}${fichaCard}</div>
    </div>
    <script>
    (function(){
      // Abrir siempre en el mensaje MÁS NUEVO, como WhatsApp — no arriba del todo.
      var fin = document.getElementById("fin");
      if (fin && !${buscar ? "true" : "false"}) fin.scrollIntoView({ block: "end" });
    })();
    </script>`, { key, role, nombre, permisos, refresco: 25, activa: "bandeja" });
}

// ─── Apartados de una clienta (dentro del chat) ──────────────────
function fechaCorta(ts) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleDateString("es-DO",
      { timeZone: "America/Santo_Domingo", day: "2-digit", month: "short" });
  } catch { return "—"; }
}

function estadoApartado(a) {
  if (a.estado === "entregado") return `<span class="pill hum">✅ Entregado</span>`;
  if (a.estado === "cancelado") return `<span class="pill tag">Cancelado</span>`;
  if (a.pagado_completo) return `<span class="pill hum">💚 Pagado — falta entregar</span>`;
  if (a.vencido) return `<span class="pill urg">⚠️ Vencido ${fechaCorta(a.fecha_limite)}</span>`;
  if (a.por_vencer) return `<span class="pill rojo">⏰ Vence ${fechaCorta(a.fecha_limite)}</span>`;
  return `<span class="pill amar">🔖 Hasta ${fechaCorta(a.fecha_limite)}</span>`;
}

function apartadosCard(phone, key) {
  const lista = apartados_de(phone);
  const activos = lista.filter(a => a.estado === "activo");
  const viejos = lista.filter(a => a.estado !== "activo");

  const bloque = a => {
    const pagos = pagos_de(a.id);
    return `<div style="border:1px solid var(--line);border-radius:12px;padding:11px;margin:8px 0">
      <div style="font-weight:700">${esc(a.producto)}</div>
      <div style="margin:5px 0">${estadoApartado(a)}</div>
      <div class="kv"><span>Total</span><b>RD$${rd(a.total)}</b></div>
      <div class="kv"><span>Abonado</span><b>RD$${rd(a.abonado)}</b></div>
      <div class="kv"><span>Le falta</span><b style="color:${a.balance > 0 ? "#b3261e" : "#1e6b32"}">RD$${rd(a.balance)}</b></div>
      ${pagos.length ? `<details style="margin-top:6px"><summary>Ver ${pagos.length} abono(s)</summary>
        ${pagos.map(p => `<div class="kv"><span>${esc(fmtTime(p.ts))}${p.metodo ? ` · ${esc(p.metodo)}` : ""}</span><b>RD$${rd(p.monto)}</b></div>`).join("")}
      </details>` : ""}
      ${a.notas ? `<p class="muted" style="margin:6px 0 0">${esc(a.notas)}</p>` : ""}
      ${a.estado === "activo" ? `
        <form method="post" action="/panel/apartado/abonar" style="margin-top:8px">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${a.id}">
          <input type="hidden" name="phone" value="${esc(phone)}">
          <div class="row">
            <input type="text" name="monto" inputmode="numeric" placeholder="Abono RD$" style="flex:1;min-width:100px">
            <input type="text" name="metodo" placeholder="efectivo / transf." style="flex:1;min-width:110px">
            <button type="submit" style="padding:9px 14px;font-size:.82rem">Abonar</button>
          </div>
        </form>
        <div class="row">
          <form method="post" action="/panel/apartado/estado">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${a.id}">
            <input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="estado" value="entregado">
            <button class="ghost" type="submit" style="padding:8px 12px;font-size:.78rem">✅ Entregado</button>
          </form>
          <form method="post" action="/panel/apartado/plazo">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${a.id}">
            <input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="dias" value="7">
            <button class="grey" type="submit" style="padding:8px 12px;font-size:.78rem">+7 días</button>
          </form>
          <form method="post" action="/panel/apartado/estado"
                onsubmit="return confirm('¿Cancelar este apartado?')">
            <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${a.id}">
            <input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="estado" value="cancelado">
            <button class="grey" type="submit" style="padding:8px 12px;font-size:.78rem">Cancelar</button>
          </form>
        </div>` : `
        <form method="post" action="/panel/apartado/borrar" style="margin-top:6px"
              onsubmit="return confirm('¿Borrar este registro para siempre?')">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${a.id}">
          <input type="hidden" name="phone" value="${esc(phone)}">
          <button class="grey" type="submit" style="padding:7px 11px;font-size:.75rem">Borrar registro</button>
        </form>`}
    </div>`;
  };

  return `<div class="card">
    <h3>🔖 Apartados</h3>
    ${activos.map(bloque).join("") || `<p class="muted">No tiene nada apartado.</p>`}
    ${viejos.length ? `<details><summary>Historial (${viejos.length})</summary>${viejos.map(bloque).join("")}</details>` : ""}
    <details style="margin-top:8px">
      <summary>➕ Apartar una peluca</summary>
      <form method="post" action="/panel/apartado/nuevo" style="margin-top:8px">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(phone)}">
        <input type="text" name="producto" placeholder="Qué apartó (ej: Peluca ondulada 26&quot;)" required>
        <div class="row">
          <input type="text" name="total" inputmode="numeric" placeholder="Precio total RD$" required style="flex:1;min-width:110px">
          <input type="text" name="abono" inputmode="numeric" placeholder="Abono de hoy RD$" style="flex:1;min-width:110px">
        </div>
        <div class="row">
          <input type="text" name="dias" inputmode="numeric" value="${plazo_dias()}" style="flex:1;min-width:80px">
          <span class="muted" style="flex:2">días de plazo</span>
        </div>
        <input type="text" name="notas" placeholder="Nota (color, largo, acuerdo…)">
        <button class="big" type="submit">Guardar apartado</button>
      </form>
    </details>
  </div>`;
}

// ─── Vista: INVENTARIO ───────────────────────────────────────────
async function vistaInventario(key, role, nombre, permisos, buscar = "", notice = "") {
  const k = encodeURIComponent(key);
  let cat = [];
  try { cat = await get_catalog(); } catch { cat = []; }
  const stock = todo_el_stock();
  const r = resumen_inventario();

  let lista = cat.filter(p => p.nombre);
  if (buscar) {
    const b = buscar.toLowerCase();
    lista = lista.filter(p => `${p.codigo} ${p.nombre} ${p.colores} ${p.etiquetas}`.toLowerCase().includes(b));
  }
  // Lo que está por acabarse va de primero: es lo que hay que comprar.
  lista.sort((a, b) => {
    const ea = stock.get(a.codigo), eb = stock.get(b.codigo);
    const ca = !ea ? 3 : ea.existencia <= 0 ? 0 : ea.existencia <= ea.minimo ? 1 : 2;
    const cb = !eb ? 3 : eb.existencia <= 0 ? 0 : eb.existencia <= eb.minimo ? 1 : 2;
    return ca - cb || String(a.nombre).localeCompare(String(b.nombre));
  });

  const fila = p => {
    const s = stock.get(p.codigo);
    const n = s ? s.existencia : null;
    const etiqueta = n === null ? `<span class="pill tag">sin contar</span>`
      : n <= 0 ? `<span class="pill urg">AGOTADO</span>`
      : n <= s.minimo ? `<span class="pill rojo">quedan ${n}</span>`
      : `<span class="pill hum">${n} en stock</span>`;
    return `<div class="item">
      <div class="n">${esc(p.nombre)} <span class="muted">#${esc(p.codigo)}</span></div>
      <div style="margin:5px 0">${etiqueta}${p.precio_detalle ? ` <span class="muted">RD$${rd(p.precio_detalle)}</span>` : ""}</div>
      <form method="post" action="/panel/inventario/mover" class="row" style="margin-top:4px">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="codigo" value="${esc(p.codigo)}">
        <input type="hidden" name="nombre" value="${esc(p.nombre)}">
        <button name="cantidad" value="-1" class="grey" style="padding:9px 14px">−1</button>
        <button name="cantidad" value="1" class="ghost" style="padding:9px 14px">+1</button>
        <input type="text" name="contar" inputmode="numeric" placeholder="tengo…" style="flex:1;min-width:80px">
        <button type="submit" name="accion" value="contar" style="padding:9px 13px;font-size:.8rem">Guardar</button>
      </form>
      ${s ? `<form method="post" action="/panel/inventario/olvidar" style="margin-top:5px">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="codigo" value="${esc(p.codigo)}">
        <button class="grey" type="submit" style="padding:5px 9px;font-size:.7rem">dejarlo sin contar</button>
      </form>` : ""}
      </div>`;
  };

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;

  return shell("Inventario", `
    <h2 style="margin:4px 0 10px">📦 Inventario</h2>
    ${notice}
    <div class="tiles">
      ${t(r.unidades, "Unidades en total")}
      ${t(r.productos, "Productos contados")}
      ${t(r.por_acabarse, "⏰ Por acabarse")}
      ${t(r.agotados, "🚫 Agotados")}
    </div>
    <form method="get" action="/panel/inventario" class="row" style="margin-bottom:8px">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="search" name="buscar" value="${esc(buscar)}" placeholder="Buscar producto…" style="flex:1;min-width:150px">
      <button type="submit">Buscar</button>
      ${buscar ? `<a class="pill tag" href="/panel/inventario?key=${k}">✕ quitar</a>` : ""}
    </form>
    <p class="muted">Escribe cuántas <b>tienes</b> en la cajita y dale Guardar. Los botones −1 y +1 son para arreglos rápidos.</p>
    ${lista.length ? lista.map(fila).join("") : `<p class="muted">No encontré productos.</p>`}
    <p class="muted" style="margin-top:14px">Lo que marques como <b>agotado</b> el bot deja de ofrecerlo solo. Lo que nunca has contado se queda como estaba.</p>
  `, { key, role, nombre, permisos, activa: "inventario" });
}

// ─── Vista: RESPALDO (solo jefa) ─────────────────────────────────
function vistaRespaldo(key, role, nombre) {
  const k = encodeURIComponent(key);
  const n = conteos();
  const copias = respaldos_guardados();
  const mb = b => (b / 1048576).toFixed(1);

  const botonesCsv = Object.entries(TABLAS).map(([clave, t]) =>
    `<a class="item" href="/panel/respaldo/csv/${clave}?key=${k}" style="display:flex;justify-content:space-between;align-items:center">
      <span><b>${esc(t.titulo)}</b><br><span class="muted">${rd(n[clave] ?? "")} registros</span></span>
      <span class="pill hum">⬇️ Excel</span></a>`).join("");

  return shell("Respaldo", `
    <h2 style="margin:4px 0 10px">💾 Respaldo</h2>
    <div class="card">
      <p>Todo tu negocio — conversaciones, clientas, pedidos, apartados y caja — vive en <b>un solo archivo</b> dentro del servidor. Si ese disco se daña, se pierde.</p>
      <p class="muted">Baja una copia de vez en cuando y guárdala en tu celular o tu computadora. Esa copia que está <b>fuera</b> del servidor es la que de verdad te salva.</p>
      <a class="item" href="/panel/respaldo/db?key=${k}" style="display:flex;justify-content:space-between;align-items:center;background:var(--pink-soft);border-color:var(--pink)">
        <span><b>Copia completa de todo</b><br><span class="muted">Un archivo con absolutamente todo</span></span>
        <span class="pill urg">⬇️ Bajar</span></a>
    </div>

    <h3 style="margin:18px 0 8px">Por partes (se abre en Excel)</h3>
    ${botonesCsv}

    <div class="card" style="margin-top:14px">
      <h3>🔄 Copia automática</h3>
      <p class="muted">El sistema guarda una copia al día y conserva las últimas 7, por si hay que devolverse.</p>
      ${copias.length
        ? copias.map(c => `<div class="kv"><span>${esc(c.archivo)}</span><b>${mb(c.bytes)} MB</b></div>`).join("")
        : `<p class="muted">Todavía no hay copias automáticas (la primera sale unos minutos después de cada arranque).</p>`}
      <p class="muted" style="margin-top:9px">⚠️ Estas copias viven en el <b>mismo disco</b>. Sirven si alguien borra algo por error, pero no si el disco se pierde. Para eso es la de arriba, la que bajas tú.</p>
    </div>
  `, { key, role, nombre, activa: "respaldo" });
}

// Botón para mandarse la plantilla a sí misma y verla como llega.
function formPrueba(key) {
  return `<form method="post" action="/panel/campana/prueba" style="margin-top:10px">
      <input type="hidden" name="key" value="${esc(key)}">
      <div class="row">
        <input type="text" name="destino" placeholder="Tu número (vacío = tu personal)" style="flex:1;min-width:150px">
        <button class="ghost" type="submit">📲 Mándamela a mí</button>
      </div>
      <p class="muted" style="margin:6px 0 0">Te llega igualita que a la clienta, desde el número del bot.</p>
    </form>`;
}

// ─── Vista: CAMPAÑAS (solo jefa) ─────────────────────────────────
function vistaCampanas(key, role, nombre, notice = "") {
  const k = encodeURIComponent(key);
  const activa = campana_activa();
  const historial = listar_campanas().filter(c => !activa || c.id !== activa.id);

  // Cuánta gente hay en cada público, para que decida con números.
  let n_escribieron = 0, n_nunca = 0;
  try { n_escribieron = audiencia("escribieron", 7).length; } catch { }
  try { n_nunca = audiencia("nunca", 7).length; } catch { }

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;

  const enCurso = activa ? (() => {
    const c = conteo(activa.id);
    const pct = c.total ? Math.round((c.enviados / c.total) * 100) : 0;
    const tasa = c.enviados ? Math.round((c.respondieron / c.enviados) * 100) : 0;
    return `<div class="card">
      <h3>📣 Campaña en curso</h3>
      <div style="font-weight:700;font-size:1.05rem">${esc(activa.nombre)}</div>
      <div class="muted" style="margin-bottom:8px">${esc(activa.audiencia)} · ${activa.por_dia} por día</div>
      <div style="background:#eee;border-radius:20px;height:10px;overflow:hidden;margin:10px 0">
        <div style="width:${pct}%;height:100%;background:var(--pink)"></div>
      </div>
      <div class="tiles">
        ${t(c.enviados + "/" + c.total, "Enviados")}
        ${t(c.hoy + "/" + activa.por_dia, "Hoy")}
        ${t(c.respondieron, "💬 Respondieron")}
        ${t(tasa + "%", "🎯 Respuesta")}
      </div>
      ${c.saltados ? `<p class="muted">${c.saltados} saltadas (ya estaban escribiendo o pidieron no recibir).</p>` : ""}
      ${c.fallidos ? `<p class="muted">${c.fallidos} fallidas.</p>` : ""}
      <div class="row">
        <form method="post" action="/panel/campana/estado">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${activa.id}">
          <input type="hidden" name="estado" value="pausada">
          <button class="grey" type="submit">⏸️ Pausar</button>
        </form>
        <form method="post" action="/panel/campana/estado"
              onsubmit="return confirm('¿Terminar la campaña? No se le escribirá a las que faltan.')">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${activa.id}">
          <input type="hidden" name="estado" value="terminada">
          <button class="grey" type="submit">⏹️ Terminar</button>
        </form>
      </div>
      <p class="muted" style="margin:9px 0 0">Sale de 9am a 8pm, con 12 segundos entre cada mensaje. Las que respondan caen solitas en tu bandeja y las atiende Claude.</p>
      <p class="muted">📲 Todos los días a las 8pm te aviso por WhatsApp cómo va: cuántas salieron, cuántas te respondieron y si eso es bueno o malo.</p>
      ${formPrueba(key)}
    </div>
    <div class="card">
      <h3>📤 Mandarle algo a las que respondieron</h3>
      <p class="muted" style="margin:0 0 8px">Escribe una vez y le llega a todas las que te contestaron. <b>No le llega dos veces a nadie:</b> a la que ya recibió ese mismo mensaje se la salta sola.</p>
      <form method="post" action="/panel/campana/mensaje"
            onsubmit="return confirm('¿Mandarle este mensaje a todas las que respondieron?')">
        <input type="hidden" name="key" value="${esc(key)}">
        <textarea name="msg" rows="5" placeholder="Ej: Amor, mira esta peluca 100% humana 26&quot; en RD$7,990…" required></textarea>
        <button class="big" type="submit">Mandárselo a todas</button>
      </form>
      <p class="muted" style="margin:8px 0 0">Puedes pegar el link de un reel o de un video: le llega para que lo abra.</p>
    </div>
    ${(() => {
      const r = respondieron_lista(activa.id);
      if (!r.length) return "";
      return `<h3 style="margin:18px 0 8px">💬 Te respondieron (${r.length})</h3>
        <p class="muted" style="margin:0 0 6px">Estas son las que hay que atender. Tócalas para abrir su chat.</p>
        ${r.map(x => `<a class="item" href="/panel/chat?key=${k}&phone=${encodeURIComponent(x.phone)}">
          <span class="time">${esc(hace(x.cuando))}</span>
          <div class="n">${esc(x.nombre || x.phone)}</div>
          <div class="p">${esc((x.respuesta || "(mandó una foto o un audio)").replace(/\s+/g, " ").slice(0, 80))}</div></a>`).join("")}`;
    })()}`;
  })() : "";

  const historialHtml = historial.map(c => `<div class="item">
      <span class="time">${esc(fmtTime(c.created_at))}</span>
      <div class="n">${esc(c.nombre)} <span class="pill ${c.estado === "terminada" ? "hum" : "tag"}">${esc(c.estado)}</span></div>
      <div class="p">${c.enviados} enviados · ${c.respondieron} respondieron${c.enviados ? ` (${Math.round((c.respondieron / c.enviados) * 100)}%)` : ""}</div>
      ${c.estado === "pausada" ? `<form method="post" action="/panel/campana/estado" style="margin-top:6px">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${c.id}">
        <input type="hidden" name="estado" value="activa">
        <button class="ghost" type="submit" style="padding:7px 11px;font-size:.78rem">▶️ Reanudar</button></form>` : ""}
    </div>`).join("");

  return shell("Campañas", `
    <h2 style="margin:4px 0 10px">📣 Alcanzar más clientas</h2>
    ${notice}
    ${enCurso}
    ${activa ? "" : `<div class="card">
      <h3>Nueva campaña</h3>
      <p class="muted" style="margin:0 0 10px">Le escribe a clientas que hace rato no te hablan, con el mensaje que Meta ya te aprobó:</p>
      <div class="notice" style="font-style:italic">"Hola [nombre] 💕 Soy Winny de Winny Beauty Supply. Tenemos novedades y ofertas nuevas en pelo, pelucas y productos de belleza. ¿Quieres que te cuente? Respóndeme SÍ y te atiendo al momento 🙏✨"</div>
      <form method="post" action="/panel/campana/nueva" style="margin-top:12px">
        <input type="hidden" name="key" value="${esc(key)}">
        <input type="text" name="nombre" placeholder="Nombre de la campaña (ej: Reactivación agosto)" required>

        <p style="font-weight:700;margin:14px 0 6px">¿A quién?</p>
        <label style="display:block;background:#fff;border:1.5px solid var(--line);border-radius:12px;padding:11px;margin-bottom:8px">
          <input type="radio" name="tipo" value="escribieron" checked>
          <b>Clientas que ya te escribieron</b> — ${n_escribieron} personas
          <div class="muted">Te conocen. Es el público seguro y el que más responde.</div>
        </label>
        <label style="display:block;background:#fff;border:1.5px solid #f6ccc8;border-radius:12px;padding:11px">
          <input type="radio" name="tipo" value="nunca">
          <b>Contactos que nunca han escrito</b> — ${n_nunca} personas
          <div class="muted" style="color:#8a1c24">⚠️ Son los importados de tu agenda. Nunca te han escrito por aquí, así que muchas pueden reportar el mensaje como spam — y si eso pasa, Meta te baja la calidad del número y te lo puede bloquear. Si los vas a usar, hazlo de 20 en 20.</div>
        </label>

        <div class="row" style="margin-top:12px">
          <div style="flex:1;min-width:130px">
            <div class="muted">Que lleven sin escribir</div>
            <input type="text" name="dias" inputmode="numeric" value="7"> <span class="muted">días</span>
          </div>
          <div style="flex:1;min-width:130px">
            <div class="muted">Máximo por día</div>
            <input type="text" name="por_dia" inputmode="numeric" value="50">
          </div>
        </div>
        <button class="big" type="submit">Empezar campaña</button>
      </form>
      <p class="muted" style="margin:10px 0 0">Cada mensaje de estos le cuesta a Meta unos centavos de dólar. 50 al día es poco dinero y mucho cuidado con tu número.</p>
    </div>`}

    ${historialHtml ? `<h3 style="margin:18px 0 8px">Campañas anteriores</h3>${historialHtml}` : ""}
  `, { key, role, nombre, activa: "campanas" });
}

// ─── Vista: CAJA (venta de mostrador) ────────────────────────────
// Pensada para la cajera: números grandes, pocos toques, y al final del
// día el cuadre listo. Sirve igual con el dedo en el celular que con el
// mouse en la computadora.
async function vistaCaja(key, role, nombre, notice = "", permisos = []) {
  const k = encodeURIComponent(key);
  let productos = [];
  try { productos = (await get_catalog()).filter(p => p.nombre && p.disponible); } catch { productos = []; }
  const stockCaja = todo_el_stock();
  const hoy = ventas_del_dia();
  const c = cuadre();
  const cats = categorias();

  const botonesCat = cats.map(x =>
    `<button type="button" class="opt cat" data-v="${esc(x)}">${esc(x)}</button>`).join("");
  const botonesMet = METODOS.map(m =>
    `<button type="button" class="opt met" data-v="${esc(m.id)}">${m.emoji} ${esc(m.label)}</button>`).join("");

  const lista = hoy.slice(0, 30).map(v => {
    const met = METODOS.find(m => m.id === v.metodo);
    return `<div class="item" style="${v.anulada ? "opacity:.5" : ""}">
      <span class="time">${esc(fmtTime(v.ts).split(", ")[1] || fmtTime(v.ts))}</span>
      <div class="n">${v.anulada ? "<s>" : ""}RD$${rd(v.monto)}${v.anulada ? "</s> ANULADA" : ""}</div>
      <div class="p">${met ? met.emoji + " " + esc(met.label) : esc(v.metodo)}${v.categoria ? " · " + esc(v.categoria) : ""}${v.cajera ? " · " + esc(v.cajera) : ""}</div>
      ${v.anulada ? (role === "jefa" ? `<form method="post" action="/panel/caja/borrar" style="margin-top:6px">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${v.id}">
        <button class="grey" type="submit" style="padding:6px 10px;font-size:.74rem">Quitar de la lista</button></form>` : "")
      : `<form method="post" action="/panel/caja/anular" style="margin-top:6px"
          onsubmit="return confirm('¿Anular esta venta de RD$${rd(v.monto)}?')">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${v.id}">
        <button class="grey" type="submit" style="padding:6px 10px;font-size:.74rem">Anular</button></form>`}
    </div>`;
  }).join("");

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;

  return shell("Caja", `
    <h2 style="margin:4px 0 10px">🧾 Caja — venta de hoy</h2>
    ${notice}
    <form id="fventa" method="post" action="/panel/caja">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="monto" id="fmonto">
      <input type="hidden" name="categoria" id="fcat">
      <input type="hidden" name="metodo" id="fmet">

      <div class="card" style="text-align:center;padding:18px 15px">
        <div class="muted" style="font-size:.8rem">MONTO DE LA VENTA</div>
        <div id="display" style="font-size:2.6rem;font-weight:800;letter-spacing:-1px;line-height:1.2">RD$0</div>
      </div>

      <div class="keypad">
        ${[1,2,3,4,5,6,7,8,9].map(n => `<button type="button" class="tecla" data-d="${n}">${n}</button>`).join("")}
        <button type="button" class="tecla" data-d="00">00</button>
        <button type="button" class="tecla" data-d="0">0</button>
        <button type="button" class="tecla borrar" id="borrar">⌫</button>
      </div>

      <div class="card">
        <h3>¿Qué se llevó?</h3>
        <div class="opts">${botonesCat}</div>
        ${productos.length ? `
        <div class="muted" style="margin:12px 0 5px">O escógelo del catálogo y se descuenta del inventario:</div>
        <select name="codigo" id="fprod" style="width:100%;padding:11px;border-radius:10px;border:1px solid #ccd0d6;font-size:.95rem">
          <option value="">— sin producto del catálogo —</option>
          ${productos.map(p => {
            const s = stockCaja.get(p.codigo);
            const info = !s ? "" : s.existencia <= 0 ? " · AGOTADO" : ` · quedan ${s.existencia}`;
            return `<option value="${esc(p.codigo)}" data-precio="${Number(p.precio_detalle) || 0}">${esc(p.nombre)} — RD$${rd(p.precio_detalle)}${esc(info)}</option>`;
          }).join("")}
        </select>
        <p class="muted" style="margin:6px 0 0">Al escogerlo se pone el precio solo. Puedes cambiarlo con el teclado si le hiciste rebaja.</p>` : ""}
      </div>

      <div class="card">
        <h3>¿Cómo pagó?</h3>
        <div class="opts">${botonesMet}</div>
      </div>

      <button class="big" type="submit" id="cobrar" style="font-size:1.15rem;padding:16px">COBRAR</button>
      <p class="muted" id="aviso" style="text-align:center;margin-top:8px"></p>
    </form>

    <h3 style="margin:20px 0 8px">💰 Cuadre de hoy</h3>
    <div class="tiles">
      ${t("RD$" + rd(c.total), "Total del día")}
      ${METODOS.map(m => t("RD$" + rd(c.por_metodo[m.id].total), m.emoji + " " + m.label)).join("")}
      ${t(c.cantidad, "🧾 Ventas")}
    </div>

    <h3 style="margin:18px 0 8px">Ventas de hoy</h3>
    ${lista || `<p class="muted">Todavía no se ha cobrado nada hoy.</p>`}

    ${bloqueGastos(key, role)}
    ${bloqueCierre(key, role)}
    ${role === "jefa" ? `<div class="card" style="margin-top:14px">
      <h3>⚙️ Botones de producto</h3>
      <form method="post" action="/panel/caja/categorias">
        <input type="hidden" name="key" value="${esc(key)}">
        <input type="text" name="cats" value="${esc(cats.join(", "))}">
        <button class="ghost big" type="submit">Guardar</button>
      </form>
      <p class="muted" style="margin:8px 0 0">Sepáralos con comas. Son los botones que ve la cajera.</p>
    </div>` : ""}

    <style>
    .keypad{display:grid;grid-template-columns:repeat(3,1fr);gap:9px;margin:12px 0}
    .tecla{background:#fff;color:var(--ink);border:1px solid var(--line);font-size:1.6rem;font-weight:700;
      padding:18px 0;border-radius:14px}
    .tecla:active{background:var(--pink-soft)}
    .tecla.borrar{background:#f3f4f6;font-size:1.3rem}
    .opts{display:flex;flex-wrap:wrap;gap:8px}
    .opt{background:#fff;color:var(--ink);border:1.5px solid var(--line);font-weight:600;font-size:.9rem;
      padding:12px 15px;border-radius:12px}
    .opt.sel{background:var(--pink);color:#fff;border-color:var(--pink)}
    </style>
    <script>
    (function(){
      var digits = "";
      var display = document.getElementById("display");
      var fmonto = document.getElementById("fmonto");
      var fcat = document.getElementById("fcat");
      var fmet = document.getElementById("fmet");
      var aviso = document.getElementById("aviso");

      function pinta(){
        var n = digits ? parseInt(digits, 10) : 0;
        display.textContent = "RD$" + n.toLocaleString("es-DO");
        fmonto.value = String(n);
      }
      Array.prototype.forEach.call(document.querySelectorAll(".tecla[data-d]"), function(b){
        b.addEventListener("click", function(){
          if (digits.length < 9) { digits += b.getAttribute("data-d"); digits = digits.replace(/^0+(?=\\d)/, ""); pinta(); }
        });
      });
      document.getElementById("borrar").addEventListener("click", function(){
        digits = digits.slice(0, -1); pinta();
      });
      function grupo(clase, campo){
        Array.prototype.forEach.call(document.querySelectorAll("." + clase), function(b){
          b.addEventListener("click", function(){
            var ya = b.classList.contains("sel");
            Array.prototype.forEach.call(document.querySelectorAll("." + clase), function(o){ o.classList.remove("sel"); });
            if (!ya) { b.classList.add("sel"); campo.value = b.getAttribute("data-v"); }
            else { campo.value = ""; }
          });
        });
      }
      grupo("cat", fcat);
      grupo("met", fmet);

      // Al escoger un producto del catálogo se pone su precio solo.
      var prod = document.getElementById("fprod");
      if (prod) prod.addEventListener("change", function(){
        var op = prod.options[prod.selectedIndex];
        var precio = op ? parseInt(op.getAttribute("data-precio") || "0", 10) : 0;
        if (precio > 0) { digits = String(precio); pinta(); }
      });

      document.getElementById("fventa").addEventListener("submit", function(e){
        if (!fmonto.value || fmonto.value === "0") { e.preventDefault(); aviso.textContent = "⚠️ Falta el monto"; return; }
        if (!fmet.value) { e.preventDefault(); aviso.textContent = "⚠️ Falta marcar cómo pagó"; return; }
        aviso.textContent = "";
      });
      pinta();
    })();
    </script>
  `, { key, role, nombre, permisos, activa: "caja" });
}

// ─── Gastos del día (dentro de la caja) ──────────────────────────
function bloqueGastos(key, role) {
  const gastos = gastos_del_dia();
  const total = total_gastos();
  const filas = gastos.map(gg => `<div class="kv">
      <span>${esc(fmtTime(gg.ts).split(", ")[1] || "")} · ${esc(gg.categoria || "Otro")}${gg.nota ? ` — ${esc(gg.nota)}` : ""}${gg.quien ? ` · ${esc(gg.quien)}` : ""}</span>
      <b>RD$${rd(gg.monto)}
        ${role === "jefa" ? `<form method="post" action="/panel/caja/gasto/borrar" style="display:inline">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${gg.id}">
          <button class="grey" type="submit" style="padding:2px 7px;font-size:.7rem;margin-left:6px">✕</button></form>` : ""}
      </b></div>`).join("");

  return `<div class="card" style="margin-top:18px">
    <h3>💸 Gastos de hoy — RD$${rd(total)}</h3>
    ${filas || `<p class="muted">No se ha registrado ningún gasto hoy.</p>`}
    <details style="margin-top:9px">
      <summary>➖ Anotar un gasto</summary>
      <form method="post" action="/panel/caja/gasto" style="margin-top:8px">
        <input type="hidden" name="key" value="${esc(key)}">
        <div class="row">
          <input type="text" name="monto" inputmode="numeric" placeholder="Monto RD$" required style="flex:1;min-width:110px">
          <select name="categoria" style="flex:1;min-width:130px;padding:10px;border-radius:10px;border:1px solid #ccd0d6">
            ${CATEGORIAS_GASTO.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
          </select>
        </div>
        <div class="row">
          <select name="metodo" style="flex:1;min-width:130px;padding:10px;border-radius:10px;border:1px solid #ccd0d6">
            ${METODOS.map(m => `<option value="${esc(m.id)}">${m.emoji} ${esc(m.label)}</option>`).join("")}
          </select>
          <input type="text" name="nota" placeholder="¿De qué fue?" style="flex:2;min-width:130px">
        </div>
        <button class="ghost big" type="submit">Guardar gasto</button>
      </form>
      <p class="muted" style="margin:8px 0 0">Solo el gasto en <b>efectivo</b> sale de la gaveta. Lo de tarjeta o transferencia se anota igual, pero no afecta el conteo.</p>
    </details>
  </div>`;
}

// ─── Cierre de caja ──────────────────────────────────────────────
function bloqueCierre(key, role) {
  const cerrado = cierre_de_hoy();
  const esperado = efectivo_esperado();
  const c = cuadre();
  const gastos = total_gastos();

  if (cerrado) {
    const dif = Number(cerrado.diferencia) || 0;
    const color = Math.abs(dif) < 1 ? "#1e6b32" : "#b3261e";
    return `<div class="card" style="margin-top:14px">
      <h3>🔒 Caja cerrada</h3>
      <div class="kv"><span>Efectivo que debía haber</span><b>RD$${rd(cerrado.efectivo_esperado)}</b></div>
      <div class="kv"><span>Efectivo contado</span><b>RD$${rd(cerrado.efectivo_contado)}</b></div>
      <div class="kv"><span>Diferencia</span><b style="color:${color}">${dif > 0 ? "+" : ""}RD$${rd(dif)}</b></div>
      <div class="kv"><span>Ventas del día</span><b>RD$${rd(cerrado.total_ventas)}</b></div>
      <div class="kv"><span>Gastos del día</span><b>RD$${rd(cerrado.total_gastos)}</b></div>
      <p class="muted" style="margin-top:8px">Cerrada por ${esc(cerrado.quien || "—")} a las ${esc(fmtTime(cerrado.ts).split(", ")[1] || "")}.
        ${Math.abs(dif) < 1 ? "Cuadró perfecto 💚" : dif > 0 ? "Sobró dinero en la gaveta." : "Faltó dinero en la gaveta."}</p>
    </div>`;
  }

  return `<div class="card" style="margin-top:14px">
    <h3>🔒 Cerrar la caja</h3>
    <div class="kv"><span>💵 Entró en efectivo</span><b>RD$${rd(c.por_metodo.efectivo.total)}</b></div>
    <div class="kv"><span>💸 Salió en efectivo</span><b>− RD$${rd(c.por_metodo.efectivo.total - esperado)}</b></div>
    <div class="kv"><span><b>Debería haber en la gaveta</b></span><b>RD$${rd(esperado)}</b></div>
    <form method="post" action="/panel/caja/cerrar" style="margin-top:10px"
          onsubmit="return confirm('¿Cerrar la caja del día con lo que contaste?')">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="text" name="contado" inputmode="numeric" placeholder="¿Cuánto efectivo contaste? RD$" required>
      <button class="big" type="submit">Cerrar caja del día</button>
    </form>
    <p class="muted" style="margin:8px 0 0">Cuenta el efectivo de la gaveta y escríbelo. El sistema te dice si falta o sobra.</p>
    ${role === "jefa" ? (() => {
      const previos = cierres_recientes(7).filter(x => x.dia !== inicioDelDia());
      return previos.length ? `<details style="margin-top:10px"><summary>Cierres anteriores</summary>
        ${previos.map(x => `<div class="kv"><span>${esc(fechaCorta(x.dia))}</span>
          <b>RD$${rd(x.total_ventas)} ${Math.abs(x.diferencia) < 1 ? "✅" : (x.diferencia > 0 ? "▲" : "▼") + " RD$" + rd(Math.abs(x.diferencia))}</b></div>`).join("")}
      </details>` : "";
    })() : ""}
  </div>`;
}

// ─── Vista: PEDIDOS (solo jefa) ──────────────────────────────────
// Antes esto era un enlace a /pending, que devolvía datos crudos (JSON) y
// parecía roto. Ahora es una página de verdad, ordenada por urgencia.
function vistaPedidos(key, role, nombre) {
  const k = encodeURIComponent(key);
  let abiertos = [];
  try { abiertos = get_open_orders(); } catch (e) {
    return shell("Pedidos", `<div class="notice err">No pude leer los pedidos: ${esc(e.message)}</div>`,
      { key, role, nombre, activa: "pedidos" });
  }

  const now = Date.now();
  const GRUPOS = [
    { estado: "awaiting_verification", titulo: "⚠️ Pagaron — falta que confirmes", clase: "rojo",
      ayuda: "Mandaron el comprobante. Revísalo y confírmalo para que salga la factura." },
    { estado: "paid", titulo: "📦 Pagados — falta enviar", clase: "amar",
      ayuda: "Ya está el dinero. Falta despacharlos." },
    { estado: "awaiting_payment", titulo: "⏳ Esperando que paguen", clase: "ia", ayuda: "" },
    { estado: "draft", titulo: "🛒 Carritos sin terminar", clase: "tag",
      ayuda: "Empezaron a pedir y no cerraron. Buenos para dar seguimiento." }
  ];

  const tarjeta = o => {
    const dias = Math.floor((now - (o.created_at || now)) / 86400000);
    const nombreCli = o.customer_name || o.contact_name || o.phone;
    const comprobante = o.receipt_path
      ? `<a href="/comprobantes/${encodeURIComponent(String(o.receipt_path).split(/[\\/]/).pop())}" target="_blank">📄 ver comprobante</a>`
      : "";
    return `<div class="item">
      <span class="time">${dias === 0 ? "hoy" : `${dias} día(s)`}</span>
      <div class="n">${esc(nombreCli)}</div>
      <div class="p" style="white-space:normal">${esc(productos_de(o.items) || "—")}</div>
      <div class="muted" style="margin-top:4px">
        ${o.total ? `<b>RD$${rd(o.total)}</b> · ` : ""}${esc(o.phone.replace(/^whatsapp:/, ""))}
        ${o.delivery_address ? ` · ${esc(String(o.delivery_address).slice(0, 60))}` : ""}
      </div>
      <div class="row" style="margin-top:7px">
        <a class="pill hum" href="/panel/chat?key=${k}&phone=${encodeURIComponent(o.phone)}">💬 Abrir conversación</a>
        ${comprobante ? `<span class="pill tag">${comprobante}</span>` : ""}
      </div>
      ${o.status === "awaiting_verification" ? `<div class="row" style="margin-top:8px">
        <form method="post" action="/panel/pedido/confirmar"
              onsubmit="return confirm('¿El pago de ${esc(nombreCli)} sí llegó? Se le avisa y se le manda la factura.')">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(o.phone)}">
          <button type="submit" style="padding:9px 13px;font-size:.82rem">✅ Confirmar pago</button>
        </form>
        <form method="post" action="/panel/pedido/rechazar"
              onsubmit="return confirm('¿Avisarle que su pago NO ha llegado?')">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(o.phone)}">
          <button class="grey" type="submit" style="padding:9px 13px;font-size:.82rem">✖️ No ha llegado</button>
        </form>
      </div>` : ""}
      ${o.status === "paid" ? `<form method="post" action="/panel/pedido/enviado" style="margin-top:8px">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="phone" value="${esc(o.phone)}">
        <div class="row">
          <input type="text" name="empresa" placeholder="Empresa (Caribe Tours…)" style="flex:1;min-width:120px">
          <input type="text" name="guia" placeholder="Guía / #" style="flex:1;min-width:90px">
          <button type="submit" style="padding:9px 13px;font-size:.82rem">🚚 Marcar enviado</button>
        </div></form>` : ""}
      </div>`;
  };

  const secciones = GRUPOS.map(g => {
    const items = abiertos.filter(o => o.status === g.estado);
    if (!items.length) return "";
    return `<h3 style="margin:18px 0 6px">${g.titulo} <span class="pill ${g.clase}">${items.length}</span></h3>
      ${g.ayuda ? `<p class="muted" style="margin:0 0 6px">${g.ayuda}</p>` : ""}
      ${items.map(tarjeta).join("")}`;
  }).join("");

  // Si NO hay pedidos abiertos, hay que distinguir dos cosas muy distintas:
  // que todo esté cerrado (bien) o que el bot no esté registrando nada (mal).
  let recientes = 0;
  try {
    recientes = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?")
      .get(now - 30 * 86400000)?.n || 0;
  } catch { recientes = 0; }

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;
  const cuenta = e => abiertos.filter(o => o.status === e).length;
  const dinero = e => abiertos.filter(o => o.status === e).reduce((s, o) => s + (Number(o.total) || 0), 0);

  return shell("Pedidos", `
    <h2 style="margin:4px 0 10px">🧾 Pedidos abiertos</h2>
    <div class="tiles">
      ${t(cuenta("awaiting_verification"), "⚠️ Por confirmar")}
      ${t(cuenta("paid"), "📦 Por enviar")}
      ${t(cuenta("awaiting_payment"), "⏳ Esperando pago")}
      ${t("RD$" + rd(dinero("awaiting_verification") + dinero("paid")), "💰 Dinero en juego")}
    </div>
    ${secciones || (recientes
      ? `<p class="muted">No hay pedidos abiertos ahora mismo ✨ (${recientes} pedido(s) en los últimos 30 días, ya cerrados)</p>`
      : `<div class="notice err"><b>Ojo:</b> no hay ningún pedido registrado en los últimos 30 días.
         Si has estado vendiendo, quiere decir que el bot está conversando pero <b>no está guardando los pedidos</b>
         (pasó antes, en julio). Dímelo y lo reviso.</div>`)}
    <p class="muted" style="margin-top:16px">Para confirmar un pago y que salga la factura, escríbele al bot desde tu WhatsApp: <b>confirmar +número</b>. Los estados de envío se siguen manejando en tu hoja de Google.</p>
  `, { key, role, nombre, activa: "pedidos" });
}

// ─── Vista: APARTADOS (todas) ────────────────────────────────────
function vistaApartados(key, role, nombre, filtro, notice = "", permisos = []) {
  const k = encodeURIComponent(key);
  const r = resumen_apartados();
  const lista = todos_apartados(filtro === "historial" ? "todos" : "activo")
    .filter(a => filtro === "historial" ? a.estado !== "activo" : true);

  const orden = { vencido: 0, listo: 1, por_vencer: 2, normal: 3 };
  const cat = a => a.vencido ? "vencido" : a.pagado_completo ? "listo" : a.por_vencer ? "por_vencer" : "normal";
  lista.sort((a, b) => (orden[cat(a)] - orden[cat(b)]) || ((a.fecha_limite || 0) - (b.fecha_limite || 0)));

  const filas = lista.map(a => `<a class="item" href="/panel/chat?key=${k}&phone=${encodeURIComponent(a.phone)}">
      <span class="time">${esc(fechaCorta(a.fecha_limite))}</span>
      <div class="n">${esc(a.nombre || a.phone)}</div>
      <div style="margin:5px 0">${estadoApartado(a)}</div>
      <div class="p">${esc(a.producto)} — falta <b>RD$${rd(a.balance)}</b> de RD$${rd(a.total)}</div></a>`).join("");

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;

  return shell("Apartados", `
    <h2 style="margin:4px 0 10px">🔖 Apartados</h2>
    ${notice}
    <div class="tiles">
      ${t(r.cantidad, "🔖 Activos")}
      ${t("RD$" + rd(r.por_cobrar), "💵 Por cobrar")}
      ${t("RD$" + rd(r.cobrado), "✅ Ya abonado")}
      ${t(r.vencidos, "⚠️ Vencidos")}
      ${t(r.listos, "💚 Pagados sin entregar")}
    </div>
    <div class="row" style="margin-bottom:6px">
      <a class="pill ${filtro !== "historial" ? "hum" : "tag"}" href="/panel/apartados?key=${k}">Activos</a>
      <a class="pill ${filtro === "historial" ? "hum" : "tag"}" href="/panel/apartados?key=${k}&f=historial">Historial</a>
    </div>
    ${filas || `<p class="muted">Nada por aquí.</p>`}
    ${role === "jefa" ? `<div class="card" style="margin-top:14px">
      <h3>⚙️ Plazo por defecto</h3>
      <form method="post" action="/panel/apartado/config">
        <input type="hidden" name="key" value="${esc(key)}">
        <div class="row">
          <input type="text" name="dias" inputmode="numeric" value="${plazo_dias()}" style="flex:1;min-width:90px">
          <button type="submit">Guardar</button>
        </div>
      </form>
      <p class="muted" style="margin:8px 0 0">Días que dura un apartado nuevo. El recordatorio sale 3 días antes y el día que vence.</p>
    </div>` : ""}
    <p class="muted">Para apartar algo, entra a la conversación de la clienta y usa «➕ Apartar una peluca».</p>
  `, { key, role, nombre, permisos, activa: "apartados" });
}

// ─── Vista: DASHBOARD (solo jefa) ────────────────────────────────
function vistaDashboard(key, role, nombre) {
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
  const ap = resumen_apartados();
  const caja = cuadre();
  const gastosHoy = total_gastos();
  const conv = convos ? Math.round(((pedidosHoy.n || 0) / convos) * 100) : 0;

  const t = (num, txt) => `<div class="tile"><b>${num}</b><span>${txt}</span></div>`;

  // Las que cumplen años hoy: una felicitación vende más que cualquier promoción.
  const cumpleanos = rows.filter(r => esCumpleHoy(r.cumple))
    .map(r => `<a class="item" href="/panel/chat?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(r.phone)}">
        <span class="time">🎂</span>
        <div class="n">${esc(prettyName(r.phone, r.name))}</div>
        <div class="p">Escríbele y felicítala</div></a>`).join("");

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
    <h3 style="margin:16px 0 8px">🧾 Caja de la tienda hoy</h3>
    <div class="tiles">
      ${t("RD$" + rd(caja.total), "Total mostrador")}
      ${METODOS.map(m => t("RD$" + rd(caja.por_metodo[m.id].total), m.emoji + " " + m.label)).join("")}
      ${t(caja.cantidad, "🧾 Ventas")}
      ${t("RD$" + rd(gastosHoy), "💸 Gastos")}
      ${t("RD$" + rd(caja.total - gastosHoy), "📈 Entró menos salió")}
    </div>
    <h3 style="margin:16px 0 8px">🔖 Apartados</h3>
    <div class="tiles">
      ${t(ap.cantidad, "🔖 Activos")}
      ${t("RD$" + rd(ap.por_cobrar), "💵 Por cobrar")}
      ${t("RD$" + rd(ap.cobrado), "✅ Ya abonado")}
      ${t(ap.vencidos, "⚠️ Vencidos")}
      ${t(ap.listos, "💚 Pagados sin entregar")}
    </div>
    <h3 style="margin:16px 0 8px">👥 Quién trabajó hoy</h3>
    ${tablaProductividad(desde)}
    ${bloqueSupervisor(key)}
    ${cumpleanos ? `<h3 style="margin:16px 0 8px">🎂 Cumpleaños de hoy</h3>${cumpleanos}` : ""}
    ${urgentes ? `<h3 style="margin:16px 0 8px">⏱️ Llevan más tiempo esperando</h3>${urgentes}` : ""}
    <p class="muted" style="margin-top:14px">Los números son de hoy en horario de Santo Domingo. «Atendió Claude» / «Atendió humano» cuenta clientas distintas, no mensajes.</p>
  `, { key, role, nombre, activa: "dash" });
}

// Tabla de productividad: cada persona (y Claude) con lo que hizo en el periodo.
function tablaProductividad(desde) {
  const filas = productividad(desde);
  if (!filas.length) return `<p class="muted">Todavía no hay actividad en este periodo.</p>`;
  return `<div class="card" style="padding:0;overflow-x:auto">
    <table style="width:100%;border-collapse:collapse;font-size:.86rem;min-width:520px">
      <tr style="background:#faf7fa;text-align:left">
        <th style="padding:9px 12px">Quién</th><th>Clientas</th><th>Mensajes</th>
        <th>Respuesta</th><th>Ventas</th><th style="padding-right:12px">Monto</th></tr>
      ${filas.map(f => `<tr style="border-top:1px solid var(--line)">
        <td style="padding:9px 12px;font-weight:700">${esc(f.quien)}</td>
        <td>${f.clientas}</td>
        <td>${f.mensajes}</td>
        <td>${f.respuesta_media_min === null ? "—" : `${f.respuesta_media_min} min`}</td>
        <td>${f.ventas}</td>
        <td style="padding-right:12px">RD$${rd(f.monto)}</td></tr>`).join("")}
    </table></div>
  <p class="muted">«Respuesta» es lo que tarda en contestarle a una clienta que está esperando. Las ventas se le atribuyen a la última persona que le escribió antes de que pagara; si nadie la tocó, son de Claude.</p>`;
}

// Interruptor del supervisor de IA + cuánto ha analizado hoy.
function bloqueSupervisor(key) {
  const on = supervisor_encendido();
  const hoy = analisis_hoy();
  return `<div class="card" style="margin-top:14px">
    <h3>🕵️ Supervisor de IA</h3>
    <p class="muted" style="margin:0 0 8px">
      ${on
        ? "Encendido: Claude revisa solo las conversaciones con movimiento y te avisa por WhatsApp cuando una clienta necesita a una persona."
        : "Apagado: nadie está revisando las conversaciones en segundo plano."}
    </p>
    <div class="kv"><span>Estado</span><b>${on ? "🟢 Encendido" : "⚪ Apagado"}</b></div>
    <div class="kv"><span>Conversaciones analizadas hoy</span><b>${hoy}</b></div>
    <form method="post" action="/panel/supervisor">
      <input type="hidden" name="key" value="${esc(key)}">
      <input type="hidden" name="estado" value="${on ? "off" : "on"}">
      <button class="${on ? "grey" : ""} big" type="submit">${on ? "Apagar supervisor" : "Encender supervisor"}</button>
    </form>
    <p class="muted" style="margin:8px 0 0">Cada análisis gasta créditos de Claude. Apágalo si los créditos están bajos.</p>
  </div>`;
}

// ─── Vista: EQUIPO (solo jefa) ───────────────────────────────────
function vistaEquipo(key, role, nombre, notice = "") {
  const k = encodeURIComponent(key);
  const emps = list_employees(true);
  const desde = Date.now() - 7 * 86400000;
  const prod = productividad(desde);
  const dato = nm => prod.find(p => p.quien === nm) || { clientas: 0, mensajes: 0, ventas: 0, monto: 0, respuesta_media_min: null };

  const filas = emps.map(e => {
    const d = dato(e.nombre);
    const link = `${config.public_base_url}/panel?key=${encodeURIComponent(e.clave)}`;
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div><b style="font-size:1.05rem">${esc(e.nombre)}</b>
          <span class="pill ${e.activa ? "hum" : "tag"}">${e.activa ? "activa" : "desactivada"}</span></div>
      </div>
      <div class="kv"><span>Últimos 7 días</span><b>${d.clientas} clientas · ${d.mensajes} mensajes</b></div>
      <div class="kv"><span>Respuesta media</span><b>${d.respuesta_media_min === null ? "—" : `${d.respuesta_media_min} min`}</b></div>
      <div class="kv"><span>Ventas atribuidas</span><b>${d.ventas} · RD$${rd(d.monto)}</b></div>
      <form method="post" action="/panel/equipo/permisos" style="margin:10px 0">
        <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${e.id}">
        <div class="muted" style="margin-bottom:5px">Qué puede ver (WhatsApp lo tiene siempre):</div>
        ${PERMISOS.map(pp => {
          const on = String(e.permisos || "").split(",").map(s => s.trim()).includes(pp.id);
          return `<label style="display:block;font-size:.87rem;margin:3px 0">
            <input type="checkbox" name="permisos" value="${esc(pp.id)}" ${on ? "checked" : ""}>
            <b>${esc(pp.label)}</b> <span class="muted">— ${esc(pp.detalle)}</span></label>`;
        }).join("")}
        <button class="ghost" type="submit" style="padding:8px 12px;font-size:.8rem;margin-top:6px">Guardar permisos</button>
      </form>
      <p class="muted" style="margin:9px 0 4px">Su enlace personal (mándaselo por WhatsApp):</p>
      <input type="text" readonly value="${esc(link)}" onclick="this.select()" style="font-size:.78rem">
      <div class="row">
        <form method="post" action="/panel/equipo/estado">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${e.id}">
          <input type="hidden" name="activa" value="${e.activa ? 0 : 1}">
          <button class="grey" type="submit" style="padding:8px 12px;font-size:.8rem">${e.activa ? "Desactivar" : "Reactivar"}</button>
        </form>
        <form method="post" action="/panel/equipo/clave">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${e.id}">
          <button class="ghost" type="submit" style="padding:8px 12px;font-size:.8rem">Cambiar su clave</button>
        </form>
        ${e.activa ? "" : `<form method="post" action="/panel/equipo/borrar"
            onsubmit="return confirm('¿Borrar la cuenta de ${esc(e.nombre)}? Sus números del pasado se conservan.')">
          <input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="id" value="${e.id}">
          <button class="grey" type="submit" style="padding:8px 12px;font-size:.8rem">Borrar</button>
        </form>`}
      </div></div>`;
  }).join("");

  return shell("Equipo", `
    <h2 style="margin:4px 0 10px">👥 Equipo</h2>
    ${notice}
    <div class="card">
      <h3>Agregar empleada</h3>
      <form method="post" action="/panel/equipo/nueva">
        <input type="hidden" name="key" value="${esc(key)}">
        <input type="text" name="nombre" placeholder="Nombre de la empleada (ej: Ana)" required>
        <div class="muted" style="margin:10px 0 5px">Empieza <b>solo con WhatsApp</b>. Marca lo demás únicamente si lo necesita:</div>
        ${PERMISOS.map(pp => `<label style="display:block;font-size:.87rem;margin:3px 0">
          <input type="checkbox" name="permisos" value="${esc(pp.id)}">
          <b>${esc(pp.label)}</b> <span class="muted">— ${esc(pp.detalle)}</span></label>`).join("")}
        <button class="big" type="submit">Crear su cuenta</button>
      </form>
      <p class="muted" style="margin:8px 0 0">Se le genera su propio enlace. Entra con ese enlace y todo lo que responda queda a su nombre. <b>Sin marcar nada, solo ve las conversaciones de WhatsApp</b> — ni la caja, ni las ventas del día, ni los apartados.</p>
    </div>
    ${filas || `<p class="muted">Todavía no hay empleadas con cuenta propia.</p>`}
    ${EMPLOYEE_KEY ? `<p class="muted">También sigue funcionando la clave compartida vieja (aparece como «Empleada» en los números). Cuando todas tengan la suya, se puede quitar.</p>` : ""}
    <p class="muted"><a href="/panel/dashboard?key=${k}">← Volver a los números</a></p>
  `, { key, role, nombre, activa: "equipo" });
}

// ─── Rutas ───────────────────────────────────────────────────────
export function mount_panel(app) {
  // Nada del panel se guarda en caché: si la clienta escribió hace 10 segundos,
  // eso tiene que verse AHORA, no una versión vieja guardada por el navegador.
  app.use("/panel", (req, res, next) => {
    if (!/\.(js|jpg|png|webmanifest)$/.test(req.path)) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      res.setHeader("Pragma", "no-cache");
    }
    next();
  });

  const guard = (req, res) => {
    if (!ADMIN_KEY) { res.status(503).send("El panel no está configurado (falta ADMIN_KEY)."); return null; }
    const explicita = (req.query.key ?? req.body?.key ?? "").toString();
    const key = explicita || cookie_key(req);
    const yo = quien_es(key);
    if (!yo) {
      if (cookie_key(req)) borrar_cookie(res); // cookie vieja o clave revocada
      res.status(key ? 401 : 200).send(loginForm(key ? "Clave incorrecta" : ""));
      return null;
    }
    // Cada vez que entra con su clave, se renueva la sesión del celular.
    if (explicita) guardar_cookie(res, key);
    return { key, role: yo.role, nombre: yo.nombre, permisos: yo.permisos || [] };
  };

  // Corta el paso con un mensaje decente, no con un error feo.
  const sinPermiso = (g, res, que) => res.status(403).send(shell("Sin acceso",
    `<div class="card"><p>No tienes acceso a ${esc(que)}, mi amor 💕</p>
     <p class="muted">Si necesitas entrar ahí, pídeselo a Winny.</p>
     <a href="/panel?key=${encodeURIComponent(g.key)}">← Volver a las conversaciones</a></div>`,
    { key: g.key, role: g.role, nombre: g.nombre, permisos: g.permisos }));

  const soloJefa = (g, res) => {
    if (g.role === "jefa") return false;
    res.status(403).send(shell("Sin acceso",
      `<div class="card"><p>Esta sección es solo para Winny 💕</p>
       <a href="/panel?key=${encodeURIComponent(g.key)}">← Volver a la bandeja</a></div>`,
      { key: g.key, role: g.role, nombre: g.nombre }));
    return true;
  };

  const volver = (key, phone, extra = "") =>
    `/panel/chat?key=${encodeURIComponent(key)}&phone=${encodeURIComponent(phone || "")}${extra}`;

  // ── Piezas de la APP (sin clave: no llevan datos, y el navegador pide el
  //    manifest y el service worker sin cookies) ──
  app.get("/panel/manifest.webmanifest", (_req, res) => {
    res.type("application/manifest+json").json({
      name: "Winny — Centro de atención",
      short_name: "Winny Panel",
      description: "Conversaciones, clientas, apartados y pedidos de Winny Beauty Supply",
      start_url: "/panel",
      scope: "/panel",
      display: "standalone",
      orientation: "portrait",
      background_color: "#f4f5f7",
      theme_color: "#c2185b",
      lang: "es-DO",
      icons: [
        { src: "/panel/icono.jpg", sizes: "1080x1080", type: "image/jpeg", purpose: "any" },
        { src: "/panel/icono.jpg", sizes: "1080x1080", type: "image/jpeg", purpose: "maskable" }
      ]
    });
  });

  app.get("/panel/icono.jpg", (_req, res) => {
    res.sendFile(path.resolve("assets/panel/icono.jpg"), err => {
      if (err) res.status(404).end();
    });
  });

  // Service worker: NO cachea las páginas (los datos tienen que estar al día).
  // Solo guarda el ícono y muestra un aviso decente cuando no hay internet.
  app.get("/panel/sw.js", (_req, res) => {
    res.type("application/javascript").send(`const CACHE = "winny-panel-v2";
const ESTATICOS = ["/panel/icono.jpg", "/panel/manifest.webmanifest"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ESTATICOS)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (ESTATICOS.indexOf(url.pathname) !== -1) {
    e.respondWith(caches.match(req).then(r => r || fetch(req)));
    return;
  }
  e.respondWith(fetch(req).catch(() =>
    new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;padding:40px 24px;text-align:center;color:#232326"><div style="font-size:44px">📡</div><h2>Sin internet</h2><p style="color:#6b7280">El panel necesita conexión para traerte las conversaciones al día. Vuelve a intentarlo cuando tengas señal.</p></body>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});`);
  });

  app.get("/panel/salir", (_req, res) => {
    borrar_cookie(res);
    res.send(loginForm("Sesión cerrada. Escribe tu clave para volver a entrar."));
  });

  app.get("/panel", (req, res) => {
    const g = guard(req, res); if (!g) return;
    res.send(vistaBandeja(g.key, g.role, g.nombre, (req.query.f || "").toString(),
      (req.query.buscar || "").toString().trim().slice(0, 60), g.permisos));
  });

  // Instrucciones para instalarla en el celular.
  app.get("/panel/app", (req, res) => {
    const g = guard(req, res); if (!g) return;
    res.send(shell("Instalar la app", `
      <h2 style="margin:4px 0 10px">📲 Ponlo en tu celular</h2>
      <div class="card">
        <p>Es la <b>misma</b> herramienta que usas en la computadora: los mismos mensajes, las mismas clientas, los mismos apartados. Lo que hagas en el celular aparece en la computadora al instante, porque es el mismo sistema.</p>
      </div>
      <div class="card">
        <h3>📱 Android (Chrome)</h3>
        <p>1. Abre este panel en Chrome.<br>
           2. Toca los <b>tres puntitos</b> ⋮ arriba a la derecha.<br>
           3. Toca <b>«Instalar app»</b> o «Agregar a pantalla principal».<br>
           4. Confirma. Te queda el ícono de Winny en tu pantalla.</p>
      </div>
      <div class="card">
        <h3>🍎 iPhone (Safari)</h3>
        <p>1. Abre este panel en <b>Safari</b> (tiene que ser Safari).<br>
           2. Toca el botón <b>Compartir</b> ⬆️ abajo en el centro.<br>
           3. Baja y toca <b>«Añadir a pantalla de inicio»</b>.<br>
           4. Ponle <b>Winny Panel</b> y dale Añadir.</p>
      </div>
      <div class="card">
        <h3>🔐 Sobre la clave</h3>
        <p>Ya quedaste con la sesión guardada en este teléfono por 90 días: la app abre directo, sin pedirte la clave otra vez.</p>
        <p class="muted">Si te prestan el teléfono o lo pierdes, toca <b>🚪 Salir</b> arriba y la sesión se cierra.</p>
      </div>
      <div class="card">
        <h3>🔔 Avisos</h3>
        <p>Los avisos te siguen llegando por <b>WhatsApp</b> (el supervisor te escribe cuando una clienta necesita a una persona). No hace falta que tengas la app abierta.</p>
      </div>
    `, { key: g.key, role: g.role, nombre: g.nombre, activa: "app" }));
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
    res.send(vistaChat(phone, g.key, g.role, g.nombre, {
      notice, productos, q,
      buscar: (req.query.buscar || "").toString().trim().slice(0, 60),
      todos: String(req.query.todos || "") === "1",
      permisos: g.permisos
    }));
  });

  app.get("/panel/dashboard", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    res.send(vistaDashboard(g.key, g.role, g.nombre));
  });

  // ── Acciones sobre un pedido (solo jefa) ──
  // Confirmar/rechazar usan EXACTAMENTE el mismo camino que cuando Winny escribe
  // "confirmar +numero" por WhatsApp: misma factura, mismos avisos, cero lógica duplicada.
  const aPedidos = (key, extra = "") => `/panel/pedidos?key=${encodeURIComponent(key)}${extra}`;

  async function comando_dueña(texto) {
    const { handle_owner_command } = await import("./handlers/messages.js");
    return handle_owner_command({ text: texto });
  }

  app.post("/panel/pedido/confirmar", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const phone = (req.body?.phone || "").toString().replace(/\D/g, "");
    try {
      await comando_dueña(`confirmar +${phone}`);
      logger.info({ phone, quien: g.nombre }, "✅ Panel: pago confirmado desde Pedidos");
      res.redirect(aPedidos(g.key, "&ok=" + encodeURIComponent("Pago confirmado. Le avisé a la clienta y le mandé la factura.")));
    } catch (e) {
      logger.error({ err: e.message, phone }, "Panel: error confirmando el pago");
      res.redirect(aPedidos(g.key, "&err=" + encodeURIComponent("No pude confirmarlo: " + e.message)));
    }
  });

  app.post("/panel/pedido/rechazar", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const phone = (req.body?.phone || "").toString().replace(/\D/g, "");
    try {
      await comando_dueña(`rechazar +${phone}`);
      res.redirect(aPedidos(g.key, "&ok=" + encodeURIComponent("Le avisé que su pago todavía no ha llegado.")));
    } catch (e) {
      res.redirect(aPedidos(g.key, "&err=" + encodeURIComponent("Error: " + e.message)));
    }
  });

  app.post("/panel/pedido/enviado", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const b = req.body || {};
    const phone = (b.phone || "").toString();
    const guia = (b.guia || "").toString().trim().slice(0, 60) || null;
    const empresa = (b.empresa || "").toString().trim().slice(0, 60) || null;
    try {
      const id = set_shipping(phone, { guia, empresa });
      if (!id) return res.redirect(aPedidos(g.key, "&err=" + encodeURIComponent("No encontré un pedido abierto de esa clienta.")));
      const texto = `¡Tu pedido va en camino mi amor! 🚚💕` +
        (empresa ? `\n📦 Va por *${empresa}*` : "") +
        (guia ? `\n🔖 Guía: *${guia}*` : "") +
        `\n\nCualquier cosa me escribes por aquí ✨`;
      const sid = await send_text(phone, texto);
      if (sid) save_out(phone, { type: "text", content: texto, sid, agent: g.nombre });
      logger.info({ phone, empresa, guia, quien: g.nombre }, "🚚 Panel: pedido marcado como enviado");
      res.redirect(aPedidos(g.key, "&ok=" + encodeURIComponent(
        sid ? "Marcado como enviado y le avisé a la clienta." : "Marcado como enviado (no pude avisarle: pasaron 24h).")));
    } catch (e) {
      res.redirect(aPedidos(g.key, "&err=" + encodeURIComponent("Error: " + e.message)));
    }
  });

  // ── RESPALDO (solo jefa) ──
  app.get("/panel/respaldo", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    res.send(vistaRespaldo(g.key, g.role, g.nombre));
  });

  app.get("/panel/respaldo/csv/:tabla", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (g.role !== "jefa") return res.status(403).send("Solo para Winny.");
    const clave = String(req.params.tabla);
    const datos = exportar_csv(clave);
    if (datos === null) return res.status(404).send("No encontré esos datos.");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="winny-${clave}-${fecha_archivo()}.csv"`);
    res.send(datos);
  });

  app.get("/panel/respaldo/db", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (g.role !== "jefa") return res.status(403).send("Solo para Winny.");
    const tmp = path.join(config.receipts_dir, `respaldo-${Date.now()}.db`);
    try {
      await copiar_base(tmp);
      res.download(tmp, `winny-respaldo-${fecha_archivo()}.db`, () => {
        try { fs.unlinkSync(tmp); } catch { /* ya se borró */ }
      });
    } catch (e) {
      logger.error({ err: e.message }, "Respaldo: no pude copiar la base");
      res.status(500).send("No pude sacar la copia: " + e.message);
    }
  });

  // ── CAMPAÑAS (solo jefa) ──
  app.get("/panel/campanas", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    let notice = "";
    if (req.query.ok) notice = `<div class="notice">✅ ${esc(String(req.query.ok))}</div>`;
    if (req.query.err) notice = `<div class="notice err">⚠️ ${esc(String(req.query.err))}</div>`;
    res.send(vistaCampanas(g.key, g.role, g.nombre, notice));
  });

  app.post("/panel/campana/nueva", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const b = req.body || {};
    const atras = `/panel/campanas?key=${encodeURIComponent(g.key)}`;
    try {
      const r = crear_campana({
        nombre: (b.nombre || "").toString(),
        tipo: (b.tipo || "escribieron").toString(),
        dias: parseInt(String(b.dias).replace(/\D/g, ""), 10) || 7,
        por_dia: parseInt(String(b.por_dia).replace(/\D/g, ""), 10) || 50,
        por: g.nombre
      });
      return res.redirect(atras + "&ok=" + encodeURIComponent(
        `Campaña creada con ${r.total} clientas. Empieza a salir sola entre 9am y 8pm.`));
    } catch (e) {
      return res.redirect(atras + "&err=" + encodeURIComponent(e.message));
    }
  });

  // Mandarse la plantilla a sí misma para verla como le llega a la clienta.
  app.post("/panel/campana/prueba", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const atras = `/panel/campanas?key=${encodeURIComponent(g.key)}`;
    const destino = (req.body?.destino || "").toString().replace(/\D/g, "") || null;
    try {
      const sid = await enviar_prueba(destino, "Winny");
      res.redirect(atras + (sid
        ? "&ok=" + encodeURIComponent("Te la mandé por WhatsApp. Revisa tu teléfono 💕")
        : "&err=" + encodeURIComponent("WhatsApp no la aceptó. Revisa el número.")));
    } catch (e) {
      res.redirect(atras + "&err=" + encodeURIComponent("Error: " + e.message));
    }
  });

  // Mandarle el MISMO mensaje a todas las que respondieron la campaña.
  // Se salta a la que ya lo recibió: nadie recibe lo mismo dos veces.
  app.post("/panel/campana/mensaje", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const atras = `/panel/campanas?key=${encodeURIComponent(g.key)}`;
    const texto = (req.body?.msg || "").toString().trim();
    if (!texto) return res.redirect(atras + "&err=" + encodeURIComponent("Escribe el mensaje primero."));

    const ca = campana_activa();
    if (!ca) return res.redirect(atras + "&err=" + encodeURIComponent("No hay campaña activa."));

    const gente = respondieron_lista(ca.id).slice(0, 100);
    const yaLoTiene = db.prepare(`SELECT 1 AS x FROM messages
      WHERE phone = ? AND direction = 'out' AND content = ? LIMIT 1`);

    let enviados = 0, repetidas = 0, fallidas = 0;
    for (const p of gente) {
      if (yaLoTiene.get(p.phone, texto)) { repetidas++; continue; }
      try {
        const sid = await send_text(p.phone, texto);
        if (sid) {
          save_out(p.phone, { type: "text", content: texto, sid, agent: g.nombre });
          mark_human_reply(p.phone);
          enviados++;
        } else { fallidas++; }
      } catch { fallidas++; }
      await new Promise(r => setTimeout(r, 2000)); // sin ráfagas
    }
    logger.info({ enviados, repetidas, fallidas, quien: g.nombre }, "📤 Mensaje a las que respondieron");
    return res.redirect(atras + "&ok=" + encodeURIComponent(
      `Enviado a ${enviados}.` +
      (repetidas ? ` ${repetidas} ya lo tenían.` : "") +
      (fallidas ? ` ${fallidas} no se pudo (pasaron 24h).` : "")));
  });

  app.post("/panel/campana/estado", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    cambiar_estado_campana(parseInt(req.body?.id, 10), (req.body?.estado || "").toString());
    res.redirect(`/panel/campanas?key=${encodeURIComponent(g.key)}&ok=` + encodeURIComponent("Listo."));
  });

  // ── INVENTARIO (quien tenga caja) ──
  app.get("/panel/inventario", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "el inventario");
    let notice = "";
    if (req.query.ok) notice = `<div class="notice">✅ ${esc(String(req.query.ok))}</div>`;
    if (req.query.err) notice = `<div class="notice err">⚠️ ${esc(String(req.query.err))}</div>`;
    res.send(await vistaInventario(g.key, g.role, g.nombre, g.permisos,
      (req.query.buscar || "").toString().trim().slice(0, 60), notice));
  });

  app.post("/panel/inventario/mover", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "el inventario");
    const b = req.body || {};
    const codigo = (b.codigo || "").toString();
    const nombre = (b.nombre || "").toString().slice(0, 120) || null;
    const atras = `/panel/inventario?key=${encodeURIComponent(g.key)}`;
    try {
      // Si escribió cuántas tiene, eso manda sobre los botones de −1/+1.
      const contar = String(b.contar ?? "").replace(/[^\d]/g, "");
      if (contar !== "") {
        const q = ajustar(codigo, contar, { quien: g.nombre, nombre });
        return res.redirect(atras + "&ok=" + encodeURIComponent(`${nombre || codigo}: quedan ${q}`));
      }
      const q = mover(codigo, parseInt(b.cantidad, 10), { motivo: "ajuste", quien: g.nombre, nombre });
      return res.redirect(atras + "&ok=" + encodeURIComponent(
        q === null ? "No cambié nada." : `${nombre || codigo}: quedan ${q}`));
    } catch (e) {
      return res.redirect(atras + "&err=" + encodeURIComponent(e.message));
    }
  });

  app.post("/panel/inventario/olvidar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "el inventario");
    olvidar((req.body?.codigo || "").toString());
    res.redirect(`/panel/inventario?key=${encodeURIComponent(g.key)}&ok=` +
      encodeURIComponent("Ese producto volvió a quedar sin contar."));
  });

  // ── CAJA (venta de mostrador) ──
  app.get("/panel/caja", async (req, res) => {
    const g = guard(req, res); if (!g) return;
    let notice = "";
    if (req.query.ok) notice = `<div class="notice">✅ ${esc(String(req.query.ok))}</div>`;
    if (req.query.err) notice = `<div class="notice err">⚠️ ${esc(String(req.query.err))}</div>`;
    if (!puede(g, "caja")) return sinPermiso(g, res, "la caja");
    res.send(await vistaCaja(g.key, g.role, g.nombre, notice, g.permisos));
  });

  app.post("/panel/caja", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "la caja");
    const b = req.body || {};
    const atras = `/panel/caja?key=${encodeURIComponent(g.key)}`;
    try {
      const codigo = (b.codigo || "").toString().trim() || null;
      registrar_venta({
        monto: Number(String(b.monto ?? "").replace(/[^\d]/g, "")),
        categoria: (b.categoria || "").toString().trim().slice(0, 60) || null,
        metodo: (b.metodo || "").toString(),
        cajera: g.nombre,
        codigo
      });
      // Si la venta fue de un producto del catálogo, se descuenta del inventario.
      let quedan = null;
      if (codigo) quedan = mover(codigo, -1, { motivo: "venta", quien: g.nombre });
      const met = METODOS.find(m => m.id === b.metodo);
      return res.redirect(atras + "&ok=" + encodeURIComponent(
        `Venta de RD$${rd(Number(String(b.monto).replace(/[^\d]/g, "")))} cobrada${met ? " en " + met.label.toLowerCase() : ""} 💕` +
        (quedan !== null ? ` · quedan ${quedan} en inventario` : "")));
    } catch (e) {
      return res.redirect(atras + "&err=" + encodeURIComponent(e.message));
    }
  });

  app.post("/panel/caja/anular", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "la caja");
    anular_venta(parseInt(req.body?.id, 10), g.nombre);
    res.redirect(`/panel/caja?key=${encodeURIComponent(g.key)}&ok=` + encodeURIComponent("Venta anulada."));
  });

  app.post("/panel/caja/gasto", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "la caja");
    const b = req.body || {};
    const atras = `/panel/caja?key=${encodeURIComponent(g.key)}`;
    try {
      registrar_gasto({
        monto: Number(String(b.monto ?? "").replace(/[^\d]/g, "")),
        categoria: (b.categoria || "Otro").toString().slice(0, 40),
        metodo: (b.metodo || "efectivo").toString(),
        nota: (b.nota || "").toString().trim().slice(0, 200) || null,
        quien: g.nombre
      });
      res.redirect(atras + "&ok=" + encodeURIComponent("Gasto anotado."));
    } catch (e) {
      res.redirect(atras + "&err=" + encodeURIComponent(e.message));
    }
  });

  app.post("/panel/caja/gasto/borrar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    borrar_gasto(parseInt(req.body?.id, 10));
    res.redirect(`/panel/caja?key=${encodeURIComponent(g.key)}&ok=` + encodeURIComponent("Gasto borrado."));
  });

  app.post("/panel/caja/cerrar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "caja")) return sinPermiso(g, res, "la caja");
    const atras = `/panel/caja?key=${encodeURIComponent(g.key)}`;
    try {
      const r = cerrar_caja({
        efectivo_contado: Number(String(req.body?.contado ?? "").replace(/[^\d]/g, "")),
        quien: g.nombre
      });
      const msg = Math.abs(r.diferencia) < 1
        ? "Caja cerrada y cuadró perfecto 💚"
        : r.diferencia > 0
          ? `Caja cerrada. Sobraron RD$${rd(r.diferencia)} en la gaveta.`
          : `Caja cerrada. Faltaron RD$${rd(Math.abs(r.diferencia))} en la gaveta.`;
      res.redirect(atras + "&ok=" + encodeURIComponent(msg));
    } catch (e) {
      res.redirect(atras + "&err=" + encodeURIComponent(e.message));
    }
  });

  app.post("/panel/caja/borrar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    borrar_venta_anulada(parseInt(req.body?.id, 10));
    res.redirect(`/panel/caja?key=${encodeURIComponent(g.key)}&ok=` + encodeURIComponent("Listo."));
  });

  app.post("/panel/caja/categorias", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    set_categorias((req.body?.cats || "").toString());
    res.redirect(`/panel/caja?key=${encodeURIComponent(g.key)}&ok=` + encodeURIComponent("Botones actualizados."));
  });

  // ── PEDIDOS (solo jefa) ──
  app.get("/panel/pedidos", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    res.send(vistaPedidos(g.key, g.role, g.nombre));
  });

  // ── APARTADOS ──
  app.get("/panel/apartados", (req, res) => {
    const g = guard(req, res); if (!g) return;
    let notice = "";
    if (req.query.ok) notice = `<div class="notice">✅ ${esc(String(req.query.ok))}</div>`;
    if (req.query.err) notice = `<div class="notice err">⚠️ ${esc(String(req.query.err))}</div>`;
    if (!puede(g, "apartados")) return sinPermiso(g, res, "los apartados");
    res.send(vistaApartados(g.key, g.role, g.nombre, (req.query.f || "").toString(), notice, g.permisos));
  });

  // Solo dígitos: la gente escribe "8,000", "RD$8000" o "8.000".
  const monto = v => Number(String(v ?? "").replace(/[^\d]/g, ""));

  app.post("/panel/apartado/nuevo", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "apartados")) return sinPermiso(g, res, "los apartados");
    const b = req.body || {};
    const phone = (b.phone || "").toString();
    try {
      crear_apartado({
        phone,
        producto: (b.producto || "").toString().trim().slice(0, 200),
        total: monto(b.total),
        abono: monto(b.abono),
        dias: monto(b.dias) || null,
        notas: (b.notas || "").toString().trim().slice(0, 500) || null,
        por: g.nombre
      });
      res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Apartado guardado.")));
    } catch (e) {
      res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent(e.message)));
    }
  });

  app.post("/panel/apartado/abonar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "apartados")) return sinPermiso(g, res, "los apartados");
    const b = req.body || {};
    const phone = (b.phone || "").toString();
    try {
      const a = abonar(parseInt(b.id, 10), {
        monto: monto(b.monto),
        metodo: (b.metodo || "").toString().trim().slice(0, 40) || null,
        por: g.nombre
      });
      const msg = a && a.balance <= 0
        ? "Abono registrado — ¡ya está pagado completo! 💚"
        : `Abono registrado. Le faltan RD$${rd(a ? a.balance : 0)}.`;
      logger.info({ id: b.id, phone, quien: g.nombre }, "🔖 Abono registrado");
      res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent(msg)));
    } catch (e) {
      res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent(e.message)));
    }
  });

  app.post("/panel/apartado/estado", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "apartados")) return sinPermiso(g, res, "los apartados");
    const b = req.body || {};
    const phone = (b.phone || "").toString();
    cambiar_estado(parseInt(b.id, 10), (b.estado || "").toString());
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Apartado actualizado.")));
  });

  app.post("/panel/apartado/plazo", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (!puede(g, "apartados")) return sinPermiso(g, res, "los apartados");
    const b = req.body || {};
    const phone = (b.phone || "").toString();
    ampliar_plazo(parseInt(b.id, 10), monto(b.dias));
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Plazo extendido.")));
  });

  // Borrar de verdad (para apartados metidos por error). "Cancelar" deja el
  // registro en el historial; esto lo elimina. Solo la jefa.
  app.post("/panel/apartado/borrar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const phone = (req.body?.phone || "").toString();
    borrar_apartado(parseInt(req.body?.id, 10));
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent("Apartado borrado.")));
  });

  app.post("/panel/apartado/config", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const d = monto(req.body?.dias);
    if (d > 0) set_setting("apartado_dias", String(d));
    res.redirect(`/panel/apartados?key=${encodeURIComponent(g.key)}&ok=` + encodeURIComponent("Plazo guardado."));
  });

  // ── EQUIPO (solo jefa) ──
  app.get("/panel/equipo", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    let notice = "";
    if (req.query.ok) notice = `<div class="notice">✅ ${esc(String(req.query.ok))}</div>`;
    if (req.query.err) notice = `<div class="notice err">⚠️ ${esc(String(req.query.err))}</div>`;
    res.send(vistaEquipo(g.key, g.role, g.nombre, notice));
  });

  const aEquipo = (key, extra = "") => `/panel/equipo?key=${encodeURIComponent(key)}${extra}`;

  app.post("/panel/equipo/nueva", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    try {
      const e = create_employee((req.body?.nombre || "").toString(), req.body?.permisos || "");
      logger.info({ empleada: e.nombre }, "👥 Panel: empleada creada");
      res.redirect(aEquipo(g.key, "&ok=" + encodeURIComponent(`Cuenta de ${e.nombre} creada. Cópiale su enlace.`)));
    } catch (e) {
      res.redirect(aEquipo(g.key, "&err=" + encodeURIComponent(e.message)));
    }
  });

  app.post("/panel/equipo/estado", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    set_active(parseInt(req.body?.id, 10), String(req.body?.activa) === "1");
    res.redirect(aEquipo(g.key, "&ok=" + encodeURIComponent("Listo.")));
  });

  app.post("/panel/equipo/permisos", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    // Si no marca ninguna casilla, el navegador no manda nada → se queda solo con WhatsApp.
    set_permisos(parseInt(req.body?.id, 10), req.body?.permisos || "");
    res.redirect(aEquipo(g.key, "&ok=" + encodeURIComponent("Permisos guardados.")));
  });

  app.post("/panel/equipo/clave", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const clave = regenerate_key(parseInt(req.body?.id, 10));
    res.redirect(aEquipo(g.key, "&ok=" + encodeURIComponent(clave ? "Clave nueva lista — mándale el enlace otra vez." : "No encontré esa empleada.")));
  });

  app.post("/panel/equipo/borrar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    delete_employee(parseInt(req.body?.id, 10));
    res.redirect(aEquipo(g.key, "&ok=" + encodeURIComponent("Cuenta borrada.")));
  });

  // ── Diagnóstico del supervisor (solo jefa) ──
  app.get("/panel/estado", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (g.role !== "jefa") return res.status(403).json({ error: "solo la jefa" });
    res.json(estado_supervisor());
  });

  // ── Interruptor del supervisor de IA (solo jefa) ──
  app.post("/panel/supervisor", (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (soloJefa(g, res)) return;
    const estado = String(req.body?.estado) === "on" ? "on" : "off";
    set_setting("supervisor", estado);
    logger.info({ estado }, "🕵️ Supervisor: interruptor cambiado desde el panel");
    res.redirect(`/panel/dashboard?key=${encodeURIComponent(g.key)}`);
  });

  // ── Asignar la clienta a alguien del equipo ──
  app.post("/panel/asignar", (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    const quien = (req.body?.quien || "").toString().trim();
    db.prepare("UPDATE contacts SET assigned_to = ? WHERE phone = ?").run(quien || null, phone);
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent(quien ? `Asignada a ${quien}.` : "Sin asignar.")));
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
        sid,
        agent: g.nombre
      });
      if (pausar === "1") { set_handoff(phone, 120); mark_human_reply(phone); }
      else { clear_handoff(phone); mark_human_reply(phone); }
      db.prepare("UPDATE contacts SET taken_by = ?, assigned_to = COALESCE(assigned_to, ?) WHERE phone = ?")
        .run(g.nombre, g.nombre, phone);
      logger.info({ phone, quien: g.nombre, media: !!file }, "💬 Panel v2: respuesta enviada");
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
    // OJO: NO marcamos "un humano ya respondió" aquí — solo cuando de verdad se envía
    // un mensaje. Así, si quien la tomó se distrae, el bot le manda "ya te consulto"
    // a la clienta en vez de dejarla en visto (red de seguridad que ya existía).
    set_handoff(phone, 120);
    db.prepare("UPDATE contacts SET taken_by = ?, assigned_to = ? WHERE phone = ?").run(g.nombre, g.nombre, phone);
    logger.info({ phone, quien: g.nombre }, "👤 Panel v2: conversación tomada por un humano");
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
  app.post("/panel/cumple", (req, res) => {
    const g = guard(req, res); if (!g) return;
    const phone = (req.body?.phone || "").toString();
    const v = (req.body?.cumple || "").toString().trim().slice(0, 10) || null;
    db.prepare("UPDATE contacts SET cumple = ? WHERE phone = ?").run(v, phone);
    res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent(v ? "Cumpleaños guardado 🎂" : "Cumpleaños borrado.")));
  });

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
      save_out(phone, { type: "text", content: caption, sid, agent: g.nombre });

      if (raw && !esLinkDePagina) {
        try {
          const isid = await send_image(phone, raw, "");
          if (isid) save_out(phone, { type: "image", content: `[foto ${p.nombre}]`, sid: isid, agent: g.nombre });
        } catch { /* la foto es un extra: el precio ya llegó por texto */ }
      }
      mark_human_reply(phone);
      logger.info({ phone, producto: p.nombre, quien: g.nombre }, "🛍️ Panel v2: producto enviado");
      return res.redirect(volver(g.key, phone, "&ok=" + encodeURIComponent(`Enviado: ${p.nombre}`)));
    } catch (e) {
      logger.error({ err: e.message, phone }, "Panel v2: error enviando producto");
      return res.redirect(volver(g.key, phone, "&err=" + encodeURIComponent("Error: " + e.message)));
    }
  });

  // El supervisor de IA vive dentro del panel: si el panel no carga, tampoco
  // arranca él, y el bot sigue atendiendo igual.
  start_supervisor();
  start_layaway_poller();
  start_campaign_poller();
  start_backup_poller();

  logger.info("🖥️  Panel v2 montado en /panel");
}
