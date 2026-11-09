// ═══════════════════════════════════════════════════════════════
// EL INTERRUPTOR DE LA IA — un botón en el panel para que Winny
// encienda y apague las respuestas automáticas cuando quiera.
//
// Por qué NO es una variable de entorno: ya se intentó así. El corte
// de agosto dependía de BOT_ACTIVO y el bot volvió a contestar el 31
// de agosto pese al interruptor, porque la variable quedó puesta en
// Render y nadie se acordó. Un botón que Winny ve y toca, con el
// estado guardado en la base, no se le olvida a nadie.
//
// Arranca APAGADO a propósito. Después de que el bot contestara sin
// permiso, lo correcto es que haya que encenderlo a mano y no que se
// encienda solo al desplegar.
//
// Apagar la IA NO apaga el bot: los mensajes de las clientas siguen
// llegando y guardándose, Winny los ve en el panel y contesta ella.
// Lo único que se apaga son las respuestas automáticas.
// ═══════════════════════════════════════════════════════════════

import db from "./db.js";
import { logger } from "./logger.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS interruptor (
    clave       TEXT PRIMARY KEY,
    valor       TEXT NOT NULL,
    cambiado_en INTEGER NOT NULL,
    por         TEXT
  );
`);

const CLAVE_IA = "ia_respuestas";

export function ia_encendida() {
  const row = db.prepare("SELECT valor FROM interruptor WHERE clave = ?").get(CLAVE_IA);
  return row?.valor === "si";
}

export function poner_ia(encendida, quien = "panel") {
  db.prepare(`
    INSERT INTO interruptor (clave, valor, cambiado_en, por) VALUES (?, ?, ?, ?)
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor,
                                     cambiado_en = excluded.cambiado_en,
                                     por = excluded.por
  `).run(CLAVE_IA, encendida ? "si" : "no", Date.now(), quien);
  logger.warn({ encendida, quien },
    encendida ? "🟢 IA ENCENDIDA — el bot vuelve a contestar solo"
              : "🔴 IA APAGADA — el bot recibe y guarda, pero no contesta");
  return encendida;
}

export function estado_ia() {
  const row = db.prepare("SELECT valor, cambiado_en, por FROM interruptor WHERE clave = ?").get(CLAVE_IA);
  return {
    encendida: row?.valor === "si",
    cambiado_en: row?.cambiado_en || null,
    por: row?.por || null,
    nunca_tocado: !row
  };
}
