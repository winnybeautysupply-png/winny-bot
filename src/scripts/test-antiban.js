process.env.DB_PATH = process.env.DB_PATH || "./data/prueba-antiban.db";
const db = (await import("../db.js")).default;
const { upsert_contact, save_message, is_handed_off } = await import("../db.js");
const A = await import("../antiban.js");

const ok = (n, c) => console.log(`${c ? "✅" : "❌"}  ${n}`);

// Regla 1 — contacto que NUNCA escribió
upsert_contact("18090000001", null);
ok("R1: no responde a quien nunca escribió", A.revisar("18090000001","hola","m1").permitido === false);

// Contacto que SÍ escribió
upsert_contact("18090000002", null);
save_message({ phone:"18090000002", direction:"in", type:"text", content:"hola, precio de peluca?" });
const r = A.revisar("18090000002","hola, precio de peluca?","m2");
ok("R1: sí responde a quien escribió primero", r.permitido === true);

// Regla 3 — mismo mensaje dos veces
ok("R3: no contesta dos veces el mismo mensaje", A.revisar("18090000002","hola","m2").permitido === false);

// Regla 5 — pide humano
upsert_contact("18090000003", null);
save_message({ phone:"18090000003", direction:"in", type:"text", content:"quiero hablar con un humano" });
const r5 = A.revisar("18090000003","quiero hablar con un humano","m3");
ok("R5: se calla si piden humano", r5.permitido === false && r5.motivo === "pidio_humano");
ok("R5: queda en handoff (Winny lo ve en el panel)", is_handed_off("18090000003") === true);
ok("R5: 'asesora' también dispara", A.revisar("18090000003","me pasas una asesora","m4").motivo === "pidio_humano");
ok("R5: una palabra normal NO dispara", A.revisar("18090000002","tienen pelucas rubias","m5").permitido === true);

// Regla 6 — enlaces en primer mensaje
upsert_contact("18090000004", null);
const limpio = A.limpiar_enlaces("18090000004", "Hola reina! mira www.winnybeauty.com/ofertas y https://t.me/x");
ok("R6: quita enlaces al contacto nuevo", !/www\.|https?:\/\//.test(limpio));
save_message({ phone:"18090000004", direction:"out", type:"text", content:"ya le escribí" });
const con = A.limpiar_enlaces("18090000004", "mira www.winnybeauty.com/ofertas");
ok("R6: sí deja enlaces si ya hubo conversación", /www\./.test(con));

// Regla 4 — cuota diaria
const d0=new Date(); const hoy=`${d0.getFullYear()}-${String(d0.getMonth()+1).padStart(2,"0")}-${String(d0.getDate()).padStart(2,"0")}`;
db.prepare("INSERT INTO antiban_dia (dia,enviadas) VALUES (?,?) ON CONFLICT(dia) DO UPDATE SET enviadas=excluded.enviadas").run(hoy, A.MAX_POR_DIA);
ok(`R4: corta al llegar a ${A.MAX_POR_DIA} del día`, A.revisar("18090000002","hola","m9").permitido === false);
db.prepare("UPDATE antiban_dia SET enviadas = 0 WHERE dia = ?").run(hoy);

// Regla 2 — espera 5-20s con "escribiendo..."
let aviso = 0;
const t0 = Date.now();
await A.espera_humana(() => { aviso++; });
const d = Date.now() - t0;
ok(`R2: esperó ${(d/1000).toFixed(1)}s (entre 5 y 20)`, d >= 5000 && d <= 20500);
ok("R2: avisó para mostrar 'escribiendo...'", aviso === 1);

// La cuota sube solo al confirmar
const antes = A.enviadas_hoy();
const r2 = A.revisar("18090000002","otra cosa","m10");
ok("R4: no gasta cuota hasta que el mensaje sale", A.enviadas_hoy() === antes);
r2.confirmar();
ok("R4: suma al confirmar el envío", A.enviadas_hoy() === antes + 1);

// ─── Cuota mensual gratis de Meta (1,000 por número) ────────────
const m0 = A.enviadas_mes();
ok("Mes: arranca contando desde donde iba", typeof m0 === "number");
const r3 = A.revisar("18090000002","una mas","m20"); r3.confirmar();
ok("Mes: suma al confirmar", A.enviadas_mes() === m0 + 1);
ok("Mes: calcula cuántos gratis quedan",
   A.gratis_restantes() === A.GRATIS_AL_MES - A.enviadas_mes());

const res = A.resumen_cuota();
ok("Resumen: trae día, mes y si ya se paga",
   res.hoy >= 0 && res.mes >= 1 && res.pagando === false && res.gratis_al_mes === 1000);

// Simular que ya se pasó de los 1,000
const dm = new Date(); const mes = `${dm.getFullYear()}-${String(dm.getMonth()+1).padStart(2,"0")}`;
db.prepare("INSERT INTO antiban_mes (mes,enviadas) VALUES (?,?) ON CONFLICT(mes) DO UPDATE SET enviadas=excluded.enviadas")
  .run(mes, A.GRATIS_AL_MES + 50);
ok("Resumen: avisa que ya está pagando", A.resumen_cuota().pagando === true);
ok("Resumen: ya no quedan gratis", A.gratis_restantes() === 0);
const r4 = A.revisar("18090000002","otra","m21");
ok("Pasados los 1,000 el bot SIGUE contestando (no deja clientas colgadas)", r4.permitido === true);
