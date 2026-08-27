// ═══════════════════════════════════════════════════════════════
// NOTIFICACIONES PUSH — que le suene la APP en el celular.
//
// Winny quiere enterarse cuando una clienta escribe, pero en la app
// de Winny, no en su WhatsApp. Eso es Web Push: el ícono de la app le
// avisa aunque la tenga cerrada.
//
// Las llaves VAPID (las que autorizan a este servidor a mandar avisos)
// se generan SOLAS la primera vez y se guardan en la base, en el disco
// persistente. Así no hay secretos en el código ni hay que configurar
// nada a mano en Render.
//
// Los avisos van AGRUPADOS igual que los de WhatsApp: uno cada pocos
// minutos con la lista, no uno por mensaje.
// ═══════════════════════════════════════════════════════════════
import crypto from "crypto";
import webpush from "web-push";
import db from "./db.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    quien TEXT,
    created_at INTEGER NOT NULL
  );
`);

const ajuste = {
  get(k, def = null) {
    try { return db.prepare("SELECT v FROM settings WHERE k = ?").get(k)?.v ?? def; }
    catch { return def; }
  },
  set(k, v) {
    db.prepare("INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
      .run(k, String(v));
  }
};

const b64url = buf => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Genera el par de llaves la primera vez y lo guarda. Después siempre lee.
function llaves() {
  let pub = ajuste.get("vapid_public");
  let priv = ajuste.get("vapid_private");
  if (pub && priv) return { pub, priv };

  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  // La pública va como punto sin comprimir (65 bytes: 0x04 + X + Y).
  const jwk = publicKey.export({ format: "jwk" });
  pub = b64url(Buffer.concat([
    Buffer.from([4]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url")
  ]));
  priv = b64url(Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url"));

  ajuste.set("vapid_public", pub);
  ajuste.set("vapid_private", priv);
  logger.info("🔑 Llaves de notificaciones push generadas");
  return { pub, priv };
}

let listo = false;
function preparar() {
  if (listo) return true;
  try {
    const { pub, priv } = llaves();
    const contacto = config.business.owner_phone ? `mailto:winnybeautysupply@gmail.com` : "mailto:admin@example.com";
    webpush.setVapidDetails(contacto, pub, priv);
    listo = true;
    return true;
  } catch (e) {
    logger.error({ err: e.message }, "Push: no pude preparar las llaves");
    return false;
  }
}

export function llave_publica() {
  try { return llaves().pub; } catch { return null; }
}

export function guardar_suscripcion(sub, quien = null) {
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error("Suscripción incompleta");
  db.prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, quien, created_at) VALUES (?,?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, quien = excluded.quien`)
    .run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, quien, Date.now());
  logger.info({ quien }, "🔔 Suscripción push guardada");
}

export function borrar_suscripcion(endpoint) {
  db.prepare("DELETE FROM push_subs WHERE endpoint = ?").run(endpoint);
}

export function cuantas_suscripciones() {
  try { return db.prepare("SELECT COUNT(*) AS n FROM push_subs").get()?.n || 0; } catch { return 0; }
}

// Manda el aviso a TODOS los aparatos suscritos. Si un aparato ya no existe
// (desinstaló la app, cambió de teléfono), su suscripción se borra sola.
export async function notificar({ titulo, cuerpo, url = "/panel", tag = "winny" }) {
  if (!preparar()) return 0;
  const subs = db.prepare("SELECT * FROM push_subs").all();
  if (!subs.length) return 0;

  const carga = JSON.stringify({ titulo, cuerpo, url, tag });
  let enviados = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        carga
      );
      enviados++;
    } catch (e) {
      // 404/410 = el navegador ya no acepta esa suscripción: se limpia.
      if (e.statusCode === 404 || e.statusCode === 410) {
        borrar_suscripcion(s.endpoint);
        logger.info({ endpoint: s.endpoint.slice(0, 40) }, "🔔 Suscripción push vencida, borrada");
      } else {
        logger.error({ err: e.message, code: e.statusCode }, "Push: fallo enviando");
      }
    }
  }
  return enviados;
}
