process.env.DB_PATH = process.env.DB_PATH || "./data/prueba-frases.db";
const { upsert_contact, save_message } = await import("../db.js");
const A = await import("../antiban.js");

let n = 0, fallos = 0;
function prueba(frase, debe_callarse) {
  const tel = "1809000" + String(++n).padStart(4, "0");
  upsert_contact(tel, null);
  save_message({ phone: tel, direction: "in", type: "text", content: frase });
  const r = A.revisar(tel, frase, "id" + n, true);
  const se_callo = r.motivo === "pidio_humano";
  const bien = se_callo === debe_callarse;
  if (!bien) fallos++;
  console.log(`${bien ? "✅" : "❌"}  ${se_callo ? "SE CALLA " : "CONTESTA "} │ "${frase}"`);
}

console.log("\n── DEBE CONTESTAR (ventas normales) ──");
[ "hola, precio de peluca humana 26 pulgadas?",
  "tienen cabello humano?",
  "esa peluca es humana o sintetica?",
  "quiero una peluca humana",
  "necesito pelo humano 100%",
  "cuanto cuesta el cabello humano largo 30",
  "la peluca humana rubia esta disponible?",
  "quiero comprar 3 pelucas humanas",
  "hola buenas",
  "tienen delivery?",
  "me pasas el precio de la 613?",
].forEach(f => prueba(f, false));

console.log("\n── DEBE CALLARSE (pide persona) ──");
[ "quiero hablar con una persona",
  "me pasas con un humano",
  "quiero hablar con alguien",
  "necesito hablar con una asesora",
  "asesora",
  "quiero una asesora",
  "eres un bot?",
  "esto es un robot verdad",
  "quiero hablar con Winny",
  "pasame con la encargada",
  "necesito un agente",
].forEach(f => prueba(f, true));

console.log(`\n${fallos === 0 ? "✅ TODAS BIEN" : "❌ " + fallos + " FALLOS"}  (${n} frases)`);
