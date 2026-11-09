// Prueba del traductor del webhook de Meta (no toca la red).
// Correr con: npm run test-cloud
const { parse_cloud, verify_webhook } = await import("../whatsapp_cloud.js");
const { config } = await import("../config.js");

const ok = (n, c) => { console.log(`${c ? "✅" : "❌"}  ${n}`); if (!c) process.exitCode = 1; };

const sobre = (value) => ({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value }] }] });
const meta = { display_phone_number: "18495453394", phone_number_id: "PNID" };
const contacto = [{ profile: { name: "Maria" }, wa_id: "18095551234" }];

// Texto normal
let r = parse_cloud(sobre({ metadata: meta, contacts: contacto, messages: [
  { from: "18095551234", id: "wamid.AAA", timestamp: "1762700000", type: "text", text: { body: "hola, precio de peluca?" } }
]}));
ok("Texto: lo traduce bien", r.length === 1 && r[0].type === "text" && r[0].text === "hola, precio de peluca?");
ok("Texto: toma el nombre del perfil", r[0].profile_name === "Maria");
ok("Texto: guarda el id del mensaje (hace falta para 'escribiendo...')", r[0].id === "wamid.AAA");
ok("Texto: el 'to' es el número de Winny", r[0].to === "18495453394");
ok("Texto: la fecha viene en milisegundos", r[0].timestamp === 1762700000000);

// Imagen con caption (comprobante de pago)
r = parse_cloud(sobre({ metadata: meta, contacts: contacto, messages: [
  { from: "18095551234", id: "wamid.BBB", timestamp: "1762700001", type: "image",
    image: { id: "MEDIA123", mime_type: "image/jpeg", caption: "ahí está el depósito" } }
]}));
ok("Imagen: la reconoce", r[0].type === "image" && r[0].media_id === "MEDIA123");
ok("Imagen: conserva el caption", r[0].caption === "ahí está el depósito");

// Nota de voz
r = parse_cloud(sobre({ metadata: meta, messages: [
  { from: "18095551234", id: "wamid.CCC", timestamp: "1762700002", type: "audio", audio: { id: "AUD1", mime_type: "audio/ogg" } }
]}));
ok("Audio: lo reconoce como audio", r[0].type === "audio");

// Botón y lista → se vuelven texto
r = parse_cloud(sobre({ metadata: meta, messages: [
  { from: "18095551234", id: "wamid.DDD", timestamp: "1762700003", type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "b1", title: "Quiero comprar" } } }
]}));
ok("Botón: se convierte en texto", r[0].type === "text" && r[0].text === "Quiero comprar");

r = parse_cloud(sobre({ metadata: meta, messages: [
  { from: "18095551234", id: "wamid.EEE", timestamp: "1762700004", type: "interactive",
    interactive: { type: "list_reply", list_reply: { id: "r1", title: "Peluca 26 pulgadas" } } }
]}));
ok("Lista: se convierte en texto", r[0].text === "Peluca 26 pulgadas");

// Ubicación
r = parse_cloud(sobre({ metadata: meta, messages: [
  { from: "18095551234", id: "wamid.FFF", timestamp: "1762700005", type: "location",
    location: { latitude: 18.47, longitude: -69.93 } }
]}));
ok("Ubicación: la reconoce", r[0].type === "location" && r[0].latitude === 18.47);

// Acuses de entrega → NO son mensajes
r = parse_cloud(sobre({ metadata: meta, statuses: [{ id: "wamid.AAA", status: "delivered" }] }));
ok("Acuses de entrega: los ignora (no responde a ellos)", r.length === 0);

// Varios mensajes en un mismo request
r = parse_cloud(sobre({ metadata: meta, contacts: contacto, messages: [
  { from: "18095551234", id: "w1", timestamp: "1", type: "text", text: { body: "uno" } },
  { from: "18095559999", id: "w2", timestamp: "2", type: "text", text: { body: "dos" } }
]}));
ok("Varios mensajes juntos: devuelve los dos", r.length === 2 && r[1].from === "18095559999");

// Cuerpo vacío o raro
ok("Cuerpo vacío: no revienta", parse_cloud({}).length === 0 && parse_cloud(null).length === 0);

// Verificación del webhook
const t = config.wa_cloud.verify_token;
ok("Webhook: acepta el token correcto",
  verify_webhook({ "hub.mode": "subscribe", "hub.verify_token": t, "hub.challenge": "123" }).challenge === "123");
ok("Webhook: rechaza un token falso",
  verify_webhook({ "hub.mode": "subscribe", "hub.verify_token": "falso", "hub.challenge": "123" }).ok === false);
