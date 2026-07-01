// ═══════════════════════════════════════════════════════════════
// Handler principal — recibe mensaje, decide qué hacer, responde
// ═══════════════════════════════════════════════════════════════
import fs from "fs";
import path from "path";
import { config, is_business_open } from "../config.js";
import { logger } from "../logger.js";
import {
  send_text, send_image, mark_read, send_typing,
  download_media, upload_media
} from "../whatsapp.js";
import {
  upsert_contact, save_message, get_recent_messages,
  set_handoff, is_handed_off,
  get_active_order, create_order, update_order,
  get_pending_verification, get_latest_pending_verification,
  get_customer_orders, set_shipping
} from "../db.js";
import { generate_response, extract_order_from_chat, generate_owner_response, analyze_image } from "../ai.js";
import { append_order_row } from "../sheets.js";
import { generate_invoice } from "../invoice.js";
import { transcribe_audio, transcription_enabled } from "../transcribe.js";
import { find_products, get_offers } from "../catalog.js";
import { get_or_generate_image } from "../imagegen.js";

// ═══ Helpers ═══════════════════════════════════════════════════

// Recuerda la última clienta que mandó ubicación (para cotizar su envío sin escribir el número)
let last_location_from = null;

// Recuerda la última clienta cuyo comprobante se le reenvió a Winny (para confirmar/rechazar sin escribir el número)
let last_comprobante_from = null;

// Recuerda la última clienta (no-dueña) que escribió, para que Winny pueda decir "dile a la clienta..." sin el número
let last_customer_from = null;

// Recuerda el último RECIBO DE ENVÍO que Winny mandó sin número, para reenviarlo cuando ella dé el número
let last_owner_receipt = null;

// Extrae un teléfono dominicano de un texto (809/829/849). Devuelve con código país (1XXXXXXXXXX) o null.
function extract_phone(text) {
  const m = (text || "").match(/(?:\+?1[\s\-.]?)?\(?(8[024]9)\)?[\s\-.]?\d{3}[\s\-.]?\d{4}/);
  if (!m) return null;
  let d = m[0].replace(/\D/g, "");
  if (d.length === 10) d = "1" + d;                 // 809XXXXXXX -> 1809XXXXXXX
  return (d.length === 11 && d[0] === "1") ? d : null;
}

// Reenvía un recibo de ENVÍO a una clienta, guarda la guía/empresa en su pedido
// (estado 'shipped') y le avisa que su pedido ya salió.
async function forward_shipping_receipt(to, image_url, envio = {}) {
  const empresa = envio.empresa || "";
  const guia = envio.guia || "";
  const detalle = [empresa ? `📦 Empresa: *${empresa}*` : "", guia ? `🔢 Guía: *${guia}*` : ""].filter(Boolean).join("\n");
  const msg =
    "¡Hola reina! 💕 ¡Tu pedido ya fue enviado y va en camino! 📦✨\n\n" +
    (detalle ? detalle + "\n\n" : "") +
    "Aquí te dejo el recibo para que RETIRES tu paquete en la sucursal correspondiente" +
    (guia ? " con ese número de guía" : " (usa el número de guía del recibo)") +
    ". ¡Gracias por tu compra mi amor! 🛍️💖";
  const sid = await send_image(to, image_url, msg);
  if (!sid) await send_text(to, msg);
  // Guardar el recibo en la conversación de ESA clienta + marcar pedido como enviado
  save_message({ phone: to, direction: "out", type: "image", content: `[recibo de envío reenviado${empresa ? " — " + empresa : ""}${guia ? " — guía " + guia : ""}]`, media_path: null, wa_message_id: sid });
  try { set_shipping(to, { guia, empresa }); } catch (e) { logger.error({ err: e.message }, "no pude guardar envío"); }
  logger.info({ to, empresa, guia, sid }, "📦 recibo de envío reenviado + pedido marcado como enviado");
}

// Winny (dueña) manda una FOTO (recibo de envío) desde su número → leerla y reenviarla a la clienta.
async function handle_owner_image(parsed) {
  const { from, media_url, mime, caption } = parsed;
  const owner = config.business.owner_phone;
  const filename = `envio-${Date.now()}.${(mime?.split("/")[1]) || "jpg"}`;
  const save_to = path.join(config.receipts_dir, filename);

  const dl = await download_media(media_url, save_to);
  if (!dl) { await send_text(owner, "No me llegó bien la imagen jefa 😅 ¿me la reenvías?"); return; }
  const public_url = `${config.public_base_url}/comprobantes/${filename}`;

  // Leer el recibo con OCR para extraer empresa + guía (para incluirlos en el mensaje a la clienta)
  let envio = {};
  try {
    const b64 = fs.readFileSync(save_to).toString("base64");
    const media_type = (dl.mime || mime || "image/jpeg").split(";")[0];
    const cls = await analyze_image(b64, media_type, []);
    envio = cls?.datos_envio || {};
    logger.info({ empresa: envio.empresa, guia: envio.guia }, "📦 recibo de envío leído (OCR)");
  } catch (e) { logger.error({ err: e.message }, "no pude leer el recibo de envío"); }

  const target = extract_phone(caption);
  if (target) {
    last_owner_receipt = null;
    await forward_shipping_receipt(target, public_url, envio);
    await send_text(owner, `✅ Listo jefa, le reenvié el recibo a la clienta +${target} 📦${envio.empresa ? " (" + envio.empresa + ")" : ""}${envio.guia ? " guía " + envio.guia : ""} 💕`);
  } else {
    // No vino el número en la foto → guardar (con la guía leída) y pedir el número
    last_owner_receipt = { url: public_url, envio };
    await send_text(owner,
      `📦 Recibí el recibo de envío jefa${envio.empresa ? ` (${envio.empresa}${envio.guia ? ", guía " + envio.guia : ""})` : ""}. ¿A cuál clienta se lo reenvío? Mándame el número (ej: 8091234567) 💕`);
  }
}

// Formatea un número con separador de miles (ej: 2350 -> "2,350")
function rd(n) { return Number(n || 0).toLocaleString("en-US"); }

// Suma el precio de los productos de un pedido (cantidad × precio unitario)
function items_subtotal(items) {
  let arr = items;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, p) => s + (Number(p.precio_unitario_rd) || 0) * (Number(p.cantidad) || 1), 0);
}

function format_history(rows) {
  return rows.map(r => ({
    role: r.direction === "in" ? "user" : "assistant",
    content: r.content || ""
  }));
}

// Resume las compras pasadas de una clienta en texto, para que el bot la reconozca al volver.
function summarize_orders(orders) {
  if (!orders || !orders.length) return "";
  const lines = orders.map(o => {
    let arr = o.items;
    if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
    if (!Array.isArray(arr) || !arr.length) return null;
    const prods = arr
      .map(p => `${p.cantidad || 1}× ${p.nombre}${p.detalles ? ` (${p.detalles})` : ""}`)
      .join(", ");
    let fecha = "";
    try { fecha = new Date(o.created_at).toLocaleDateString("es-DO", { timeZone: config.business.timezone }); } catch {}
    const estados = { paid: "pagado", shipped: "enviado", awaiting_verification: "esperando confirmación de pago", awaiting_payment: "pendiente de pago" };
    const estado = estados[o.status] || o.status;
    const envio = o.status === "shipped"
      ? ` [ENVIADO${o.empresa_envio ? " por " + o.empresa_envio : ""}${o.guia_envio ? ", guía " + o.guia_envio : ""}]`
      : ` [${estado}]`;
    return `- ${fecha ? fecha + ": " : ""}${prods}${o.total ? ` — RD$${rd(o.total)}` : ""}${envio}`;
  }).filter(Boolean);
  return lines.join("\n");
}

async function notify_winny({ from, contact_name, reason, urgency = "media", message }) {
  const urgency_emoji = { alta: "🚨", media: "🔔", baja: "📩" }[urgency] || "🔔";
  const text = `${urgency_emoji} *Cliente necesita atención*

📱 De: +${from}${contact_name ? ` (${contact_name})` : ""}
🎯 Razón: ${reason}
${message ? `💬 Último mensaje: "${message.slice(0, 200)}"` : ""}

Atiéndela cuando puedas mi reina 💕`;
  await send_text(config.business.owner_phone, text);
}

async function send_bank_accounts(to) {
  const banks = config.business.bank_accounts;
  if (!banks.length) {
    return send_text(to, "Un momento mi amor, le aviso a Winny para que te pase los datos bancarios 💕");
  }
  const lines = banks.map(b =>
    `🏦 *${b.banco}* (${b.tipo})\nCta: ${b.numero}\nA nombre de: ${b.titular}`
  ).join("\n\n");
  const msg = `Estos son nuestros datos para transferencia 💳\n\n${lines}\n\nCuando hagas el pago, mándame foto del comprobante por aquí 📸✨`;
  return send_text(to, msg);
}

// Optimiza la imagen de Cloudinary para envío RÁPIDO y compatible con WhatsApp:
// fuerza JPG (WhatsApp no siempre acepta WebP), comprime y limita el ancho a 1080px.
// Menos peso = Twilio la busca y la entrega mucho más rápido.
function fast_media_url(url) {
  if (!url || !url.includes("res.cloudinary.com/")) return url;
  return url.replace("/upload/f_auto,q_auto/", "/upload/f_jpg,q_auto:good,w_1080/");
}

// Arma una descripción del producto (para generar la imagen con IA si no hay foto real).
function describe_product(p) {
  return [p.nombre, p.colores ? `color ${p.colores}` : "", p.etiquetas]
    .filter(Boolean).join(", ");
}

// ═══ Enviar un producto del catálogo (foto/video Cloudinary + precio) ═══
async function send_product(to, p) {
  const lines = [`🛍️ *${p.nombre}*`, `💵 RD$${rd(p.precio_detalle)}`];
  if (p.precio_mayor) lines.push(`📦 Por ${p.cant_mayor || "mayor"}: RD$${rd(p.precio_mayor)} c/u`);
  if (p.precio_caja) lines.push(`📦 Por caja${p.unidades_caja ? ` (${p.unidades_caja} und)` : ""}: RD$${rd(p.precio_caja)} c/u`);
  if (p.colores) lines.push(`🎨 Colores: ${p.colores}`);
  if (p.oferta) lines.push(`🔥 ¡EN OFERTA!`);
  const caption = lines.join("\n");
  // EL PRECIO SIEMPRE VA POR TEXTO (garantizado). La foto es un extra best-effort:
  // así, aunque Twilio no entregue la imagen, la clienta SIEMPRE recibe nombre + precio.
  const txt_sid = await send_text(to, caption);
  logger.info({ to, prod: p.nombre, precio: p.precio_detalle, txt_sid }, "📤 producto (texto)");
  // Foto REAL si existe; si no, imagen generada con IA (con caché).
  let media = (p.media_url && p.media_url.startsWith("http")) ? fast_media_url(p.media_url) : null;
  let generada = false;
  if (!media) { media = await get_or_generate_image(describe_product(p)); generada = !!media; }
  if (media) {
    const img_sid = await send_image(to, media, "");
    logger.info({ to, prod: p.nombre, img_sid, generada }, "📤 producto (foto)");
  }
}

// ═══ Handler de IMAGEN — VISIÓN primero, luego decide la acción ══════════

// Flujo de verificación de PAGO (solo cuando la imagen ES un comprobante bancario).
async function process_payment_receipt(parsed, contact, save_to, filename, cls = null) {
  const { from } = parsed;
  const order = get_active_order(from);
  if (order) update_order(order.id, { receipt_path: save_to, status: "awaiting_verification" });
  last_comprobante_from = from;

  await send_text(from,
    `¡Recibí tu comprobante mi amor! 💕✨\n\nWinny verifica que el pago haya llegado y te confirmamos enseguida para preparar tu pedido 🛍️`);
  try {
    const public_url = `${config.public_base_url}/comprobantes/${filename}`;
    // Datos leídos del comprobante con OCR (banco, monto, fecha, referencia, remitente)
    const d = cls?.datos_pago || {};
    const datos = [
      d.banco ? `🏦 Banco: ${d.banco}` : "",
      d.monto ? `💵 Monto: ${d.monto}` : "",
      d.fecha ? `📅 Fecha: ${d.fecha}` : "",
      d.referencia ? `🔢 Ref: ${d.referencia}` : "",
      d.remitente ? `👤 De: ${d.remitente}` : ""
    ].filter(Boolean).join("\n");
    const hint =
      `\n\n¿Llegó el pago, reina? 👇\n` +
      `✅ Si LLEGÓ, respóndeme:  *confirmar +${from}*\n` +
      `❌ Si NO llegó:  *rechazar +${from}*\n\n` +
      `(También puedes responder solo *confirmar* para confirmar este último.)`;
    await send_image(
      config.business.owner_phone,
      public_url,
      `💰 *Comprobante de pago recibido*\n📱 Cliente: +${from}${contact?.name ? ` (${contact.name})` : ""}${order ? `\n🧾 Pedido #${order.id}` : ""}` +
      `${datos ? `\n\n${datos}` : ""}${hint}`
    );
  } catch (err) {
    logger.error({ err: err.message }, "Error reenviando comprobante");
    await notify_winny({
      from, contact_name: contact?.name,
      reason: "Comprobante recibido — error al reenviar imagen: " + save_to,
      urgency: "alta"
    });
  }
}

async function handle_image(parsed, contact) {
  const { from, media_url, mime } = parsed;
  const filename = `${from}-${Date.now()}.${(mime?.split("/")[1]) || "jpg"}`;
  const save_to = path.join(config.receipts_dir, filename);

  const downloaded = await download_media(media_url, save_to);
  if (!downloaded) {
    await send_text(from, "Ay mi amor, no me llegó bien la imagen 😅 ¿Me la mandas otra vez por favor?");
    return;
  }

  // 1) VISIÓN: analizar la imagen ANTES de decidir qué hacer.
  let cls = null;
  try {
    const b64 = fs.readFileSync(save_to).toString("base64");
    const media_type = (downloaded.mime || mime || "image/jpeg").split(";")[0];
    const history = format_history(get_recent_messages(from, 8));
    cls = await analyze_image(b64, media_type, history);
  } catch (err) {
    logger.error({ err: err.message, from }, "Error leyendo/analizando la imagen");
  }

  const cat = cls?.categoria || "desconocida";
  const conf = cls?.confianza ?? 0;
  logger.info(
    { from, categoria: cat, es_pago: cls?.es_pago, confianza: conf, desc: (cls?.descripcion || "").slice(0, 140) },
    "🖼️ imagen clasificada (visión)"
  );

  // Guardar en el historial con la descripción de visión (para dar contexto al chat).
  save_message({
    phone: from, direction: "in", type: "image",
    content: cls
      ? `[imagen: ${cat}] ${cls.descripcion || ""}${cls.texto_visible ? " | texto: " + cls.texto_visible : ""}`
      : "(imagen)",
    media_path: save_to, wa_message_id: parsed.id
  });

  // 2) Si la visión falló → pedir aclaración (NUNCA asumir comprobante).
  if (!cls) {
    await send_text(from, "Recibí tu imagen mi amor 💕 ¿me dices qué es? (¿un comprobante de pago, una peluca que te gustó, o una foto de referencia?) para ayudarte mejor ✨");
    return;
  }

  // 3) COMPROBANTE BANCARIO (pago) → flujo de verificación de pago (con datos OCR).
  if ((cls.es_pago || cat === "comprobante_bancario") && !cls.es_recibo_envio && conf >= 0.5) {
    logger.info({ from, datos_pago: cls.datos_pago }, "🖼️→ ruta: COMPROBANTE BANCARIO (pago)");
    await process_payment_receipt(parsed, contact, save_to, filename, cls);
    return;
  }

  // 3b) RECIBO DE ENVÍO / PAQUETERÍA que manda una clienta → responder con la guía, NO es pago.
  if (cls.es_recibo_envio || cat === "recibo_envio") {
    const e = cls.datos_envio || {};
    logger.info({ from, datos_envio: e }, "🖼️→ ruta: recibo de ENVÍO (de clienta)");
    const detalle = [e.empresa ? `empresa *${e.empresa}*` : "", e.guia ? `guía *${e.guia}*` : ""].filter(Boolean).join(", ");
    await send_text(from,
      `¡Este es el recibo de envío de tu pedido reina! 📦✨ ` +
      (detalle ? `Con ${detalle} puedes retirarlo en la sucursal correspondiente. ` : `Puedes usar el número de guía para retirarlo en la sucursal correspondiente. `) +
      `Cualquier cosa con tu retiro, aquí estoy 💕`);
    return;
  }

  // 4) CABELLO / PELUCA / PERSONA / PRODUCTO → recomendar lo más parecido del catálogo.
  if (["peluca_producto", "cabello_peinado", "persona_con_peluca", "captura_producto", "maniqui"].includes(cat)) {
    logger.info({ from, cat }, "🖼️→ ruta: RECOMENDACIÓN por imagen");
    const a = cls.atributos_cabello || {};
    // (1) Buscar coincidencias REALES en el catálogo por los atributos detectados y enviarlas (foto+precio).
    //     Determinístico: no depende de que la IA "decida" llamar la herramienta.
    const query = [a.textura, a.color, a.largo, "peluca"].filter(Boolean).join(" ") || cls.descripcion || "peluca";
    const matches = await find_products(query, 2);
    logger.info({ from, query, coincidencias: matches.length }, "🔎 recomendación por foto");
    if (matches.length) {
      const attrs = [a.textura, a.color, a.largo].filter(Boolean).join(" ");
      await send_text(from, `¡Qué linda foto reina! 💕 ${attrs ? `Veo un cabello ${attrs}. ` : ""}Mira las que más se parecen de nuestro catálogo 👇✨`);
      await Promise.all(matches.map(p => send_product(from, p)));
      await send_text(from, "¿Te gustó alguna? Dime cuál y te ayudo a que la tuya salga hoy mismo 🛍️💖");
      return;
    }
    // (2) Sin coincidencia con foto real → flujo conversacional (recomienda por texto / puede generar imagen).
    const attrs2 = [a.tipo, a.textura, a.color, a.largo].filter(Boolean).join(", ");
    const synth =
      `[La clienta me envió una FOTO. Análisis de visión: ${cls.descripcion}${attrs2 ? ` (cabello visible: ${attrs2})` : ""}. ` +
      `DEBES en ESTE mensaje: comentar con cariño lo que se ve y recomendarle 2-3 pelucas del catálogo MÁS PARECIDAS CON SU PRECIO ` +
      `(ej: "se parece a nuestra Peluca rizada 28\" — RD$9,000"). 🚫 PROHIBIDO responder solo "déjame mostrarte" o "ahora mismo".]`;
    await handle_text({ ...parsed, type: "text", text: synth }, contact);
    return;
  }

  // 5) CAPTURA DE CONVERSACIÓN / DOCUMENTO / FACTURA / etc. → responder al contenido/texto.
  if (["captura_conversacion", "documento", "factura", "caja", "logo"].includes(cat)) {
    logger.info({ from, cat }, "🖼️→ ruta: responder al CONTENIDO");
    const synth =
      `[La clienta me envió una imagen tipo "${cat}". Análisis: ${cls.descripcion}.` +
      `${cls.texto_visible ? ` Texto en la imagen: "${cls.texto_visible}".` : ""} Responde de forma útil según ese contenido.]`;
    await handle_text({ ...parsed, type: "text", text: synth }, contact);
    return;
  }

  // 6) OTRO / baja confianza → pedir aclaración (jamás asumir comprobante).
  logger.info({ from, cat, conf }, "🖼️→ ruta: ACLARACIÓN (otro/baja confianza)");
  await send_text(from, "Recibí tu imagen mi amor 💕 Para ayudarte mejor, ¿me dices qué necesitas con ella? (¿es un comprobante de pago, una peluca que te gustó, o una referencia de estilo/color?) ✨");
}

// ═══ Handler de AUDIO (nota de voz) — transcribe y procesa ══════

async function handle_audio(parsed, contact) {
  const { from, media_url, mime } = parsed;

  // Si no hay transcripción configurada (sin OPENAI_API_KEY): comportamiento anterior.
  if (!transcription_enabled()) {
    await send_text(from,
      "Recibí tu audio mi amor 💕 Por ahora prefiero leer mensajes de texto, ¿me lo puedes escribir? O si prefieres hablar con Winny dime y le aviso ✨");
    set_handoff(from, 30);
    await notify_winny({
      from, contact_name: contact.name,
      reason: "Cliente envió audio — transcripción no configurada",
      urgency: "baja"
    });
    return;
  }

  // Descargar la nota de voz y transcribirla
  const ext = (mime?.split("/")[1] || "ogg").split(";")[0];
  const save_to = path.join(config.receipts_dir, "audios", `${from}-${Date.now()}.${ext}`);
  const dl = await download_media(media_url, save_to);
  if (!dl) {
    await send_text(from, "Ay mi amor, no me llegó bien tu nota de voz 😅 ¿Me la mandas otra vez o me la escribes?");
    return;
  }

  const text = await transcribe_audio(save_to, mime);
  if (!text) {
    await send_text(from, "Mi amor, no pude entender bien tu nota de voz 😅 ¿Me la escribes o me la mandas de nuevo, por favor?");
    return;
  }
  logger.info({ from, text_preview: text.slice(0, 50) }, "🎤 Audio transcrito");

  // Guardar la transcripción como mensaje de texto (para el historial/contexto)
  save_message({ phone: from, direction: "in", type: "text", content: text, wa_message_id: `${parsed.id}-tx` });

  // Procesarlo como si la clienta lo hubiera ESCRITO
  const p = { ...parsed, type: "text", text };
  if (is_owner(from)) {
    const handled = await handle_owner_command(p);
    if (!handled) await handle_owner_chat(p);
  } else {
    await handle_text(p, contact);
  }
}

// ═══ COMANDOS DE WINNY (la dueña) — confirmar/rechazar pagos ════

function is_owner(phone) {
  const norm = (s) => (s || "").replace(/\D/g, "");
  return norm(phone) === norm(config.business.owner_phone);
}

// Detecta si un mensaje de Winny es un comando (confirmar/rechazar pago, o cotizar envío).
// Devuelve {action, phone, amount} o null (si null = conversación normal, ej. Winny probando como clienta)
function parse_owner_command(text) {
  const t = (text || "").trim().toLowerCase();
  if (!t) return null;

  // Número del cliente si lo incluye (secuencia de 9+ dígitos; NO confundir con el precio)
  const phoneMatch = t.match(/\+?(\d[\d\s-]{7,}\d)/);
  const phone = phoneMatch ? phoneMatch[1].replace(/\D/g, "") : null;

  // Comando de ENVÍO: "envio 250", "envío +1809... 250", "el envio es 250"
  if (/env[ií]o/.test(t)) {
    const rest = phoneMatch ? t.replace(phoneMatch[0], " ") : t; // quitar el teléfono para no tomarlo como precio
    const amtMatch = rest.match(/(\d{1,6})/);
    const amount = amtMatch ? parseInt(amtMatch[1], 10) : null;
    if (amount != null) return { action: "shipping", phone, amount };
  }

  // ── Confirmar / rechazar pago — Winny escribe natural, en dominicano ──
  // OJO: chequear RECHAZO PRIMERO, porque "no llegó" contiene "llegó".
  const isReject =
    /\b(rechaz|cancel|falso|fake)/.test(t) ||
    /\bno\s+(\w+\s+){0,2}(lleg|entr|recib|aparec|cay|dep[oó]sit|acredit|pag)/.test(t) ||
    /\b(todav[ií]a|a[uú]n)\s+no\b/.test(t);
  if (isReject) return { action: "reject", phone };

  const isConfirm =
    /\b(confirm|aprob|acredit|verificad)/.test(t) ||
    /\b(lleg[oó]|entr[oó]|recib|cay[oó]|dep[oó]sit|pag[oó])/.test(t) ||
    /\b(ya\s+est[aá]|todo\s+bien|correcto)\b/.test(t);
  if (isConfirm) return { action: "confirm", phone };

  // Señales DÉBILES (sí / ok / dale / no a secas): solo cuentan si hay un
  // comprobante pendiente. Si no hay nada pendiente, se trata como charla normal.
  if (/^(s[ií]+|ok|okay|dale|listo|perfecto|de una|hecho)\b/.test(t))
    return { action: "confirm", phone, weak: true };
  if (/^(no|nop|negativo)\b/.test(t))
    return { action: "reject", phone, weak: true };

  return null;
}

async function handle_owner_command(parsed) {
  // ¿Hay un recibo de envío pendiente y Winny manda el número de la clienta? → reenviarlo.
  if (last_owner_receipt) {
    const t = extract_phone(parsed.text);
    if (t) {
      await forward_shipping_receipt(t, last_owner_receipt.url, last_owner_receipt.envio || {});
      await send_text(config.business.owner_phone, `✅ Reenviado el recibo de envío a la clienta +${t} 📦💕`);
      last_owner_receipt = null;
      return true;
    }
  }

  const cmd = parse_owner_command(parsed.text);
  if (!cmd) return false; // no es comando → que siga el flujo normal de conversación

  const owner = config.business.owner_phone;

  // ─── Cotizar ENVÍO a una clienta ───
  if (cmd.action === "shipping") {
    const targetPhone = cmd.phone || last_location_from;
    if (!targetPhone) {
      await send_text(owner,
        "No sé a cuál clienta cotizarle el envío mi reina 💕\n" +
        "Mándame: *envio +1809XXXXXXX 250* (su número y el precio).");
      return true;
    }
    // Buscar el pedido para calcular el TOTAL (producto + envío)
    const order = get_active_order(targetPhone) || get_pending_verification(targetPhone);
    const subtotal = order ? items_subtotal(order.items) : 0;
    const total = subtotal + cmd.amount;

    if (order) {
      const prevNotes = order.notes ? `${order.notes} | ` : "";
      update_order(order.id, { total: total || cmd.amount, notes: `${prevNotes}Envío: RD$${cmd.amount}` });
    }

    let clientMsg;
    if (subtotal > 0) {
      clientMsg =
        `¡Listo mi amor! 💕 El envío a tu zona es de *RD$${rd(cmd.amount)}*.\n\n` +
        `🛍️ Producto: RD$${rd(subtotal)}\n` +
        `🚚 Envío: RD$${rd(cmd.amount)}\n` +
        `💰 *Total a pagar: RD$${rd(total)}*\n\n` +
        `¿Confirmas tu pedido para pasarte los datos del pago? ✨`;
    } else {
      clientMsg =
        `El envío a tu zona es de *RD$${rd(cmd.amount)}* mi amor 💕\n` +
        `Este costo se suma al precio de tu pelo. ¿Confirmas tu pedido para coordinar el pago? ✨`;
    }
    await send_text(targetPhone, clientMsg);
    await send_text(owner,
      `✅ Le dije a la clienta (+${targetPhone}) que su envío es RD$${rd(cmd.amount)}` +
      (subtotal > 0 ? `, total RD$${rd(total)} (producto RD$${rd(subtotal)} + envío RD$${rd(cmd.amount)})` : "") +
      ` 💕`);
    return true;
  }

  // ─── Confirmar / rechazar PAGO ───
  let targetPhone = cmd.phone;
  let order = targetPhone ? get_pending_verification(targetPhone) : get_latest_pending_verification();
  if (!targetPhone && order) targetPhone = order.phone;
  // Respaldo: la última clienta cuyo comprobante se le reenvió a Winny
  if (!targetPhone && last_comprobante_from) {
    targetPhone = last_comprobante_from;
    order = order || get_pending_verification(targetPhone);
  }

  if (!targetPhone) {
    // Señal débil (sí/ok/no a secas) sin nada pendiente → no es comando: charla normal.
    if (cmd.weak) return false;
    await send_text(owner,
      "No tengo ningún pago pendiente de confirmar ahora mismo mi reina 💕\n" +
      "Si quieres confirmar uno, mándame: *confirmar +1809XXXXXXX* (el número del cliente).");
    return true;
  }

  if (cmd.action === "confirm") {
    if (order) update_order(order.id, { status: "paid" });

    // 1) PRIMERO confirmar a la clienta — esto SIEMPRE sale, pase lo que pase con la factura.
    await send_text(targetPhone,
      "¡Tu pago fue confirmado mi amor! 💕✨\nYa preparamos tu pedido y te lo enviamos enseguida. ¡Gracias por tu compra! 🛍️");

    // 2) Asegurar datos para la factura. Si el pedido no quedó registrado con
    //    productos (ej. la venta pasó por handoff), reconstruirlo leyendo el chat.
    let invOrder = order;
    let hasItems = false;
    if (order) {
      try { const arr = JSON.parse(order.items || "[]"); hasItems = Array.isArray(arr) && arr.length > 0; } catch {}
    }
    if (!hasItems) {
      const history = get_recent_messages(targetPhone, 30)
        .map(r => ({ role: r.direction === "in" ? "user" : "assistant", content: r.content || "" }));
      const extracted = await extract_order_from_chat(history);
      if (extracted) {
        const subt = items_subtotal(extracted.productos);
        const tot = subt + (Number(extracted.envio_rd) || 0);
        invOrder = {
          id: order?.id || Number(String(targetPhone).slice(-5)) || 0,
          phone: targetPhone,
          customer_name: extracted.nombre_cliente || order?.customer_name || "",
          delivery_address: extracted.direccion || order?.delivery_address || "",
          items: extracted.productos,
          total: tot
        };
        // Si existe el pedido en la BD, completarlo con lo extraído
        if (order) update_order(order.id, {
          items: extracted.productos,
          customer_name: invOrder.customer_name,
          delivery_address: invOrder.delivery_address,
          total: tot
        });
      }
    }

    // Generar la factura una sola vez y enviarla por separado a la clienta y a Winny
    // (cada envío independiente: si falla uno, el otro igual sale).
    let facturaUrl = null;
    if (invOrder) {
      try {
        const { filename } = await generate_invoice(invOrder);
        facturaUrl = `${config.public_base_url}/facturas/${filename}`;
      } catch (err) {
        logger.error({ err: err.message, order_id: invOrder.id }, "Error generando factura");
      }
    }
    let factClienteOk = false, factWinnyOk = false;
    if (facturaUrl) {
      try {
        const sid = await send_image(targetPhone, facturaUrl,
          `🧾 Aquí está la factura de tu pedido #${invOrder.id}, mi amor 💕`);
        factClienteOk = !!sid;
      } catch (err) { logger.error({ err: err.message }, "Error enviando factura a la clienta"); }
      try {
        const sid = await send_image(owner, facturaUrl,
          `🧾 *Factura del pedido #${invOrder.id}*${invOrder.customer_name ? ` — ${invOrder.customer_name}` : ""}\nPara que el empacador prepare el pedido 📦`);
        factWinnyOk = !!sid;
      } catch (err) { logger.error({ err: err.message }, "Error enviando factura a Winny"); }
    }

    // 3) Resumen claro para Winny de qué pasó
    let nota;
    if (factClienteOk) nota = `\n🧾 Le mandé la factura a la clienta${factWinnyOk ? " y a ti." : " (a ti no te llegó, revisa)."}`;
    else if (facturaUrl) nota = "\n⚠️ El pago quedó confirmado pero no pude enviarle la factura a la clienta (revisa el log).";
    else nota = "\n⚠️ No pude armar la factura (no encontré los productos del pedido en la conversación). Confírmame qué pidió y te la hago.";
    await send_text(owner,
      `✅ Pago confirmado${invOrder?.customer_name ? ` de *${invOrder.customer_name}*` : ""} (+${targetPhone}). Ya le avisé que su pedido va en camino 💕` + nota);
  } else {
    if (order) update_order(order.id, { status: "payment_rejected" });
    await send_text(targetPhone,
      "Mi amor, revisé y tu pago todavía NO nos ha llegado 😅\nPor favor revisa tu transferencia y confírmame, o mándame el comprobante de nuevo. Apenas entre el pago, preparo tu pedido y te lo envío 💕");
    await send_text(owner,
      `❌ Le avisé a la clienta (+${targetPhone}) que su pago aún no ha llegado y que lo revise.`);
  }

  // Limpiar para no re-confirmar/re-rechazar a la misma clienta con un "ok" o "no" suelto después.
  last_comprobante_from = null;
  return true;
}

// ═══ MODO JEFA — Winny da una orden (no es comando de pago) ═════
// El bot la trata como la dueña que comanda, NO como clienta.
async function handle_owner_chat(parsed) {
  const { from, text } = parsed;
  const history_rows = get_recent_messages(from, 8);
  const history = format_history(history_rows.slice(0, -1)); // excluir el mensaje actual
  const ai = await generate_owner_response(text, history);

  // Ejecutar órdenes (ej: reenviar un mensaje a una clienta)
  for (const tool of ai.tool_calls) {
    if (tool.name === "enviar_mensaje_cliente") {
      const target = (tool.input.telefono || "").replace(/\D/g, "") || last_customer_from || last_comprobante_from;
      if (!target) {
        await send_text(from, "¿A cuál clienta se lo mando jefa? Pásame el número 💕");
        continue;
      }
      const msg_id = await send_text(target, tool.input.mensaje);
      save_message({ phone: target, direction: "out", type: "text", content: tool.input.mensaje, wa_message_id: msg_id });
      await send_text(from, `✅ Listo jefa, le mandé a la clienta (+${target}):\n"${tool.input.mensaje}"`);
    }
  }

  // Respuesta de texto a Winny (como su asistente)
  if (ai.text) {
    const msg_id = await send_text(from, ai.text);
    save_message({ phone: from, direction: "out", type: "text", content: ai.text, wa_message_id: msg_id });
  }
}

// ═══ Handler de TEXTO (lo más común) ═══════════════════════════

async function handle_text(parsed, contact) {
  const { from, text } = parsed;

  // Si está en handoff (humano atendiendo), no responder con bot
  if (is_handed_off(from)) {
    logger.info({ from }, "Cliente en handoff — bot no responde");
    return;
  }

  // Construir historial para Claude (16 mensajes = ~8 idas y vueltas, para no olvidar el inicio del chat)
  const history_rows = get_recent_messages(from, 16);
  const history = format_history(history_rows.slice(0, -1)); // excluir mensaje actual

  const ctx = {
    is_open: is_business_open(),
    contact_name: contact?.name,
    purchase_history: summarize_orders(get_customer_orders(from, 6))
  };

  // Llamar a Claude
  const ai = await generate_response(text, history, ctx);
  logger.info({
    from,
    msg: (text || "").slice(0, 80),
    tools: (ai.tool_calls || []).map(t => t.name),
    text_preview: (ai.text || "").slice(0, 120)
  }, "🤖 Claude respondió");

  // Procesar tool calls si los hay.
  // Envuelto en try: si un tool falla (ej. envío de foto), NO debe impedir
  // que enviemos el texto con los precios más abajo.
  try {
  for (const tool of ai.tool_calls) {
    if (tool.name === "escalar_a_winny") {
      set_handoff(from, 60); // 1 hora de handoff
      await notify_winny({
        from, contact_name: contact?.name,
        reason: tool.input.razon || "Cliente solicita atención humana",
        urgency: tool.input.urgencia || "media",
        message: text
      });
    } else if (tool.name === "compartir_cuentas_bancarias") {
      await send_bank_accounts(from);
      // No mandar el texto adicional para evitar duplicar
      return;
    } else if (tool.name === "registrar_pedido") {
      const order = get_active_order(from) || { id: create_order(from) };
      const subtotal = items_subtotal(tool.input.productos || []);
      update_order(order.id, {
        status: "awaiting_payment",
        items: tool.input.productos || [],
        customer_name: tool.input.nombre_cliente,
        delivery_address: tool.input.direccion,
        payment_method: tool.input.metodo_pago,
        total: subtotal || null,
        notes: tool.input.notas || ""
      });
      // Notificar a Winny del pedido
      const items_text = (tool.input.productos || [])
        .map(p => `• ${p.cantidad}× ${p.nombre}${p.detalles ? ` (${p.detalles})` : ""}${p.precio_unitario_rd ? ` — RD$${rd(p.precio_unitario_rd)}` : ""}`)
        .join("\n");
      await send_text(config.business.owner_phone,
        `🛍️ *Nuevo pedido* (#${order.id})\n\n` +
        `📱 +${from}\n` +
        `👤 ${tool.input.nombre_cliente}\n` +
        `📍 ${tool.input.direccion}\n` +
        `💳 ${tool.input.metodo_pago}\n\n` +
        `*Productos:*\n${items_text}\n` +
        (subtotal ? `\n🛍️ Subtotal producto: *RD$${rd(subtotal)}* (falta sumar envío)\n` : "") +
        (tool.input.notas ? `📝 ${tool.input.notas}\n` : "") +
        `\nEl bot ya le pidió el pago. Tú confirmas disponibilidad y total final 💕`
      );

      // Guardar el pedido en Google Sheets (no bloquea la respuesta al cliente)
      const productos = tool.input.productos || [];
      const fecha = new Date().toLocaleString("es-DO", { timeZone: config.business.timezone });
      const nombres_prod = productos.map(p => p.nombre).filter(Boolean).join(", ");
      const cantidad_total = productos.reduce((s, p) => s + (Number(p.cantidad) || 1), 0);
      const detalles = productos.map(p => p.detalles).filter(Boolean).join(" / ");
      append_order_row([
        fecha,                                    // Fecha
        tool.input.nombre_cliente || "",          // Nombre
        `+${from}`,                               // Teléfono
        nombres_prod,                             // Producto
        cantidad_total,                           // Cantidad
        detalles,                                 // Color/Largo
        subtotal ? `RD$${rd(subtotal)}` : "",     // Total (producto, falta envío)
        "Pendiente de pago",                      // Estado del pago
        tool.input.direccion || ""                // Dirección
      ]).catch(err => logger.error({ err: err.message }, "Sheets append falló"));
    } else if (tool.name === "mostrar_producto") {
      const prods = await find_products(tool.input.descripcion || "", 2);
      logger.info({ desc: tool.input.descripcion, encontrados: prods.length }, "🔎 mostrar_producto");
      if (!prods.length) {
        // No hay foto real en el catálogo → generar imagen con IA de la descripción.
        // (El precio/características ya van en el texto de Claude.)
        const url = await get_or_generate_image(tool.input.descripcion || "peluca de cabello humano");
        if (url) {
          const img_sid = await send_image(from, url, "");
          logger.info({ desc: tool.input.descripcion, img_sid }, "📤 imagen generada enviada");
        } else {
          await send_text(from, "Mi amor, déjame confirmar ese producto con Winny y te lo muestro enseguida 💕");
        }
      } else {
        // Respuesta inmediata + fotos en PARALELO (no una por una) para que llegue rápido
        await send_text(from, "¡Claro reina! Mira 👇✨");
        await Promise.all(prods.map(p => send_product(from, p)));
      }
    } else if (tool.name === "mostrar_ofertas") {
      const offers = await get_offers();
      if (!offers.length) {
        await send_text(from, "Ahora mismo no tengo ofertas activas mi amor 💕 pero dime qué buscas y te doy el mejor precio ✨");
      } else {
        await send_text(from, "¡Mira nuestras ofertas, mi amor! 🔥");
        await Promise.all(offers.slice(0, 6).map(p => send_product(from, p)));
      }
    }
  }
  } catch (err) {
    logger.error({ err: err.message, from }, "Fallo ejecutando tool_calls; envío el texto de todas formas");
  }

  // Enviar respuesta de texto al cliente
  if (ai.text) {
    const msg_id = await send_text(from, ai.text);
    save_message({
      phone: from, direction: "out", type: "text",
      content: ai.text, wa_message_id: msg_id
    });
  }
}

// ═══ Router principal ══════════════════════════════════════════

export async function handle_incoming(parsed, contact_profile) {
  const { from, type, id } = parsed;

  // Upsert contacto y guardar mensaje entrante
  upsert_contact(from, contact_profile?.name);
  const contact = { name: contact_profile?.name };

  // Recordar la última clienta (no-dueña) para que Winny diga "dile a la clienta..."
  if (!is_owner(from)) last_customer_from = from;

  save_message({
    phone: from, direction: "in", type,
    content: parsed.text || parsed.caption || "",
    media_path: null, wa_message_id: id
  });

  // Marcar como leído + indicador de typing
  try {
    await mark_read(id);
  } catch (e) { /* no critical */ }

  // ¿Es WINNY (la dueña/JEFA) escribiendo? Su número personal manda.
  // 1) Si es un comando de pago (confirmar/rechazar/envío) → se ejecuta.
  // 2) Si no → MODO JEFA: el bot la trata como la dueña que da órdenes,
  //    NUNCA como clienta (no le manda chchara de venta).
  if (is_owner(from) && (type === "text" || type === "interactive" || type === "button")) {
    try {
      const handled = await handle_owner_command(parsed);
      if (handled) return;
      await handle_owner_chat(parsed);
    } catch (err) {
      logger.error({ err: err.message, from }, "Error en mensaje de Winny (modo jefa)");
    }
    return; // El mensaje de la dueña NUNCA cae al bot de clientas.
  }
  // Winny manda una FOTO (recibo de envío) → reenviarla a la clienta, NO tratarla como comprobante.
  if (is_owner(from) && type === "image") {
    try { await handle_owner_image(parsed); }
    catch (err) { logger.error({ err: err.message, from }, "Error en imagen de Winny (recibo de envío)"); }
    return;
  }

  // Despachar según tipo
  switch (type) {
    case "text":
    case "interactive":
    case "button":
      await handle_text(parsed, contact);
      break;
    case "image":
      await handle_image(parsed, contact);
      break;
    case "audio":
      await handle_audio(parsed, contact);
      break;
    case "location": {
      await send_text(from, "¡Gracias por tu ubicación mi amor! 📍 Winny te confirma el costo del envío según tu zona en breve 💕");
      last_location_from = from; // recordar para cotizar con "envio <precio>"
      const maps = `https://maps.google.com/?q=${parsed.latitude},${parsed.longitude}`;
      await send_text(config.business.owner_phone,
        `📍 *Ubicación para envío (Santo Domingo)*\n` +
        `📱 Cliente: +${from}${contact.name ? ` (${contact.name})` : ""}\n` +
        `🗺️ Ver zona: ${maps}\n\n` +
        `Para decirle el costo del envío respóndeme:\n*envio 250*  (el precio para su zona)\n` +
        `o  *envio +${from} 250*`);
      break;
    }
    default:
      logger.warn({ type, from }, "Tipo de mensaje no manejado");
      await send_text(from, "Recibí tu mensaje mi amor 💕 ¿Me lo puedes mandar como texto? Así te ayudo más rápido ✨");
  }
}
