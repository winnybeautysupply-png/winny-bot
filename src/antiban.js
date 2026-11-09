// ═══════════════════════════════════════════════════════════════
// REGLAS ANTI-BLOQUEO — los frenos del bot cuando habla por WAHA
// (el número propio de Winny, conectado por QR).
//
// Conectar el WhatsApp de siempre por QR va contra los términos de
// Meta y el número se puede perder. Estas reglas no eliminan ese
// riesgo: lo bajan. Son las que Winny pidió, y están aquí como
// frenos duros y no como opciones, para que nadie las pueda apagar
// por descuido desde una variable de entorno.
//
// Las seis:
//   1. Solo se le responde a quien escribió primero. Nunca iniciar.
//   2. Esperar entre 5 y 20 segundos al azar, mostrando "escribiendo...".
//   3. Una sola respuesta automática por mensaje recibido.
//   4. Máximo 200 respuestas automáticas por día.
//   5. "humano", "persona" o "asesora" → el bot se calla y avisa a Winny.
//   6. Sin enlaces en el primer mensaje a un contacto nuevo.
//
// El contador del día y la lista de mensajes ya contestados viven en
// la misma base SQLite que el resto, así que sobreviven a un
// reinicio: si el bot se cae y vuelve, no se le reinicia la cuota.
// ═══════════════════════════════════════════════════════════════

import db from "./db.js";
import { set_handoff } from "./db.js";
import { logger } from "./logger.js";

export const MAX_POR_DIA = 200;

// Meta regala 1,000 mensajes de servicio por número y por mes. No se
// acumulan: se reinician el día 1. A partir del 1,001 empieza a cobrar.
// Esto NO bloquea al bot — sería peor dejar clientas sin contestar por
// ahorrar centavos — pero deja el aviso en el log y en el panel para
// que Winny sepa cuándo cruzó a terreno pagado.
export const GRATIS_AL_MES = 1000;
const AVISA_AL = 0.8; // avisar al llegar al 80% de los gratis
const ESPERA_MIN_MS = 5000;
const ESPERA_MAX_MS = 20000;

// La clienta pide una persona de verdad.
//
// OJO: no se puede buscar "humano" o "humana" sueltas. En este negocio
// "peluca humana" y "cabello humano" son el producto estrella, así que
// esa palabra aparece en casi toda conversación de venta. Buscarla sola
// callaba al bot justo con las clientas que venían a comprar.
//
// Por eso se busca la INTENCIÓN (hablar con / pásame con / quiero una),
// y "humano" sólo cuenta acompañado de un verbo de pedir atención.
// "quiero" nunca se junta con humano/humana, porque "quiero una peluca
// humana" es una venta, no una queja.
const PIDE_HUMANO = new RegExp([
  // "hablar con una persona", "me pasas con un humano", "que me atienda alguien"
  "\\b(hablar|habla|hablo|comunicarme|comunicar|pasame|p[aá]same|pasas|pasar|atienda|atienda|atienden|atender)\\b[^.?!]{0,25}\\b(humano|humana|persona|asesora|asesor|alguien|agente|encargad[ao]|due[ñn]a|winny)\\b",
  // "quiero una persona", "necesito un agente" — sin humano/humana a propósito
  "\\b(quiero|necesito|dame|deme|d[eé]jame|p[oó]ngame|ponme|puedo)\\b[^.?!]{0,25}\\b(persona|asesora|asesor|agente|encargad[ao])\\b",
  // "¿eres un bot?", "esto es un robot"
  "\\b(eres|es|son|est[aá]s)\\b[^.?!]{0,12}\\b(bot|robot|m[aá]quina|inteligencia artificial)\\b",
  // sola no es ambigua en este negocio
  "\\basesora\\b"
].join("|"), "i");

// Enlaces de cualquier forma: http://, https://, www. y dominios sueltos
// tipo "winnybeauty.com/oferta". El objetivo es el primer mensaje a un
// contacto nuevo, que es donde Meta más castiga.
const ENLACE = /(https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(com|net|org|do|io|me|link|shop|store|app)\b\S*)/gi;

db.exec(`
  CREATE TABLE IF NOT EXISTS antiban_dia (
    dia        TEXT PRIMARY KEY,
    enviadas   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS antiban_mes (
    mes        TEXT PRIMARY KEY,
    enviadas   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS antiban_contestados (
    message_id TEXT PRIMARY KEY,
    creado_en  INTEGER NOT NULL
  );
`);

function mes_actual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function hoy() {
  // Fecha local del servidor. A Winny le importa el día de su negocio,
  // no el UTC, así que se usa la hora local y no toISOString().
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ─── Regla 4: cuota diaria ───────────────────────────────────────
export function enviadas_hoy() {
  const row = db.prepare("SELECT enviadas FROM antiban_dia WHERE dia = ?").get(hoy());
  return row ? row.enviadas : 0;
}

export function queda_cuota() {
  return enviadas_hoy() < MAX_POR_DIA;
}

function sumar_envio() {
  db.prepare(`
    INSERT INTO antiban_dia (dia, enviadas) VALUES (?, 1)
    ON CONFLICT(dia) DO UPDATE SET enviadas = enviadas + 1
  `).run(hoy());
  db.prepare(`
    INSERT INTO antiban_mes (mes, enviadas) VALUES (?, 1)
    ON CONFLICT(mes) DO UPDATE SET enviadas = enviadas + 1
  `).run(mes_actual());

  // Aviso justo al cruzar cada frontera, una sola vez, no en cada mensaje.
  const n = enviadas_mes();
  if (n === Math.ceil(GRATIS_AL_MES * AVISA_AL)) {
    logger.warn({ enviadas_mes: n, gratis: GRATIS_AL_MES },
      `⚠️ Vas por ${n} de los ${GRATIS_AL_MES} mensajes gratis del mes`);
  } else if (n === GRATIS_AL_MES + 1) {
    logger.warn({ enviadas_mes: n },
      `💸 Se acabaron los ${GRATIS_AL_MES} gratis del mes — desde aquí Meta cobra`);
  }
}

// ─── Cuota mensual gratis de Meta ────────────────────────────────
export function enviadas_mes() {
  const row = db.prepare("SELECT enviadas FROM antiban_mes WHERE mes = ?").get(mes_actual());
  return row ? row.enviadas : 0;
}

export function gratis_restantes() {
  return Math.max(0, GRATIS_AL_MES - enviadas_mes());
}

// Resumen para el panel: cuánto va del día, del mes, y si ya se paga.
export function resumen_cuota() {
  const mes = enviadas_mes();
  return {
    hoy: enviadas_hoy(),
    max_dia: MAX_POR_DIA,
    mes,
    gratis_al_mes: GRATIS_AL_MES,
    gratis_restantes: gratis_restantes(),
    pagando: mes > GRATIS_AL_MES
  };
}

// ─── Regla 3: una sola respuesta por mensaje recibido ────────────
// Se marca ANTES de contestar, no después: si dos webhooks del mismo
// mensaje llegan a la vez (WhatsApp reintenta), el segundo encuentra
// la fila ya puesta y se va sin responder.
function reservar_mensaje(message_id) {
  if (!message_id) return true; // sin id no se puede deduplicar; se deja pasar
  try {
    db.prepare("INSERT INTO antiban_contestados (message_id, creado_en) VALUES (?, ?)")
      .run(message_id, Date.now());
    return true;
  } catch {
    return false; // ya existía → este mensaje ya se contestó
  }
}

// ─── Regla 1: solo a quien escribió primero ──────────────────────
export function escribio_primero(phone) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE phone = ? AND direction = 'in'"
  ).get(phone);
  return (row?.n || 0) > 0;
}

// ─── Regla 6: sin enlaces en el primer mensaje ───────────────────
function es_contacto_nuevo(phone) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM messages WHERE phone = ? AND direction = 'out'"
  ).get(phone);
  return (row?.n || 0) === 0;
}

export function limpiar_enlaces(phone, texto) {
  if (!texto || !es_contacto_nuevo(phone)) return texto;
  if (!ENLACE.test(texto)) { ENLACE.lastIndex = 0; return texto; }
  ENLACE.lastIndex = 0;
  const limpio = texto.replace(ENLACE, "").replace(/\s{2,}/g, " ").trim();
  logger.warn({ phone }, "🔗 Enlace quitado del primer mensaje a un contacto nuevo");
  return limpio;
}

// ─── Regla 5: pide humano → el bot se calla ──────────────────────
// Devuelve true si hay que callarse. Usa el handoff que ya existe en
// el bot, así el panel lo ve igual que cualquier otra escalada.
export function pidio_humano(phone, texto) {
  if (!texto || !PIDE_HUMANO.test(texto)) return false;
  set_handoff(phone, 24 * 60); // 24 horas callado en ese chat
  logger.warn({ phone }, "🙋 La clienta pidió una persona — bot callado y aviso a Winny");
  return true;
}

// ─── Regla 2: espera humana con "escribiendo..." ─────────────────
// on_typing se llama al empezar la espera para que WAHA muestre el
// "escribiendo..." mientras tanto. Si falla, la espera sigue igual:
// el freno importa más que el adorno.
export async function espera_humana(on_typing) {
  const ms = ESPERA_MIN_MS + Math.floor(Math.random() * (ESPERA_MAX_MS - ESPERA_MIN_MS));
  if (typeof on_typing === "function") {
    try { await on_typing(ms); } catch (e) {
      logger.debug({ err: e?.message }, "No se pudo mostrar 'escribiendo...'");
    }
  }
  logger.debug({ ms }, "⏳ Espera humana antes de responder");
  await new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════════════
// PUERTA ÚNICA — todo mensaje entrante por WAHA pasa por aquí antes
// de que el bot piense siquiera en responder.
//
// Devuelve { permitido: false, motivo } cuando hay que callarse, o
// { permitido: true, confirmar() } cuando se puede responder. La
// cuota se suma al llamar confirmar(), es decir cuando el mensaje
// salió de verdad, para no gastar cuota con respuestas que fallaron.
// ═══════════════════════════════════════════════════════════════
// es_entrante=true cuando esto se llama desde el webhook, o sea con el
// mensaje de la clienta en la mano. Ahí la regla 1 ya está cumplida por
// definición: nos acaba de escribir. Consultar la base en ese momento
// daría falso negativo, porque el mensaje todavía no se ha guardado —
// lo guarda handle_incoming después. La regla sigue estricta para
// cualquier otro que quiera mandar algo (pollers, campañas, avisos).
export function revisar(phone, texto, message_id, es_entrante = false) {
  if (pidio_humano(phone, texto)) {
    return { permitido: false, motivo: "pidio_humano", avisar_a_winny: true };
  }
  if (!es_entrante && !escribio_primero(phone)) {
    return { permitido: false, motivo: "no_escribio_primero" };
  }
  if (!queda_cuota()) {
    logger.warn({ enviadas: enviadas_hoy() }, `🛑 Tope de ${MAX_POR_DIA} respuestas automáticas del día`);
    return { permitido: false, motivo: "cuota_diaria" };
  }
  if (!reservar_mensaje(message_id)) {
    return { permitido: false, motivo: "ya_contestado" };
  }
  return { permitido: true, confirmar: sumar_envio };
}
