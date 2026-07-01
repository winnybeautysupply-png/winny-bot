// ═══════════════════════════════════════════════════════════════
// Handler principal — recibe mensaje, decide qué hacer, responde
// ═══════════════════════════════════════════════════════════════
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
  get_customer_orders
} from "../db.js";
import { generate_response, extract_order_from_chat, generate_owner_response } from "../ai.js";
import { append_order_row } from "../sheets.js";
import { generate_invoice } from "../invoice.js";
import { transcribe_audio, transcription_enabled } from "../transcribe.js";
import { find_products, get_offers } from "../catalog.js";

// ═══ Helpers ═══════════════════════════════════════════════════

// Recuerda la última clienta que mandó ubicación (para cotizar su envío sin escribir el número)
let last_location_from = null;

// Recuerda la última clienta cuyo comprobante se le reenvió a Winny (para confirmar/rechazar sin escribir el número)
let last_comprobante_from = null;

// Recuerda la última clienta (no-dueña) que escribió, para que Winny pueda decir "dile a la clienta..." sin el número
let last_customer_from = null;

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
    return `- ${fecha ? fecha + ": " : ""}${prods}${o.total ? ` — RD$${rd(o.total)}` : ""}`;
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
  if (p.media_url && p.media_url.startsWith("http")) {
    const img_sid = await send_image(to, fast_media_url(p.media_url), "");
    logger.info({ to, prod: p.nombre, img_sid }, "📤 producto (foto)");
  }
}

// ═══ Handler de IMAGEN (probable comprobante de pago) ══════════

async function handle_image(parsed, contact) {
  const { from, media_url, mime } = parsed;
  const filename = `${from}-${Date.now()}.${(mime?.split("/")[1]) || "jpg"}`;
  const save_to = path.join(config.receipts_dir, filename);

  const downloaded = await download_media(media_url, save_to);
  if (!downloaded) {
    await send_text(from, "Ay mi amor, no me llegó bien la imagen 😅 ¿Me la mandas otra vez por favor?");
    return;
  }

  // Guardar en el pedido activo si hay uno
  const order = get_active_order(from);
  if (order) {
    update_order(order.id, { receipt_path: save_to, status: "awaiting_verification" });
  }
  // Recordar esta clienta para que Winny pueda confirmar/rechazar con solo "llegó"/"no llegó"
  last_comprobante_from = from;

  save_message({
    phone: from, direction: "in", type: "image",
    content: parsed.caption || "(comprobante)",
    media_path: save_to, wa_message_id: parsed.id
  });

  // Confirmar al cliente (sin prometer que ya va en camino — falta que Winny confirme el pago)
  await send_text(from,
    `¡Recibí tu comprobante mi amor! 💕✨\n\nWinny verifica que el pago haya llegado y te confirmamos enseguida para preparar tu pedido 🛍️`);

  // Reenviar el comprobante (la FOTO) a Winny vía URL pública, con instrucciones para confirmar
  try {
    const public_url = `${config.public_base_url}/comprobantes/${filename}`;
    const hint =
      `\n\n¿Llegó el pago, reina? 👇\n` +
      `✅ Si LLEGÓ, respóndeme:  *confirmar +${from}*\n` +
      `❌ Si NO llegó:  *rechazar +${from}*\n\n` +
      `(También puedes responder solo *confirmar* para confirmar este último.)`;
    await send_image(
      config.business.owner_phone,
      public_url,
      `💰 *Comprobante de pago recibido*\n📱 Cliente: +${from}${contact?.name ? ` (${contact.name})` : ""}${order ? `\n🧾 Pedido #${order.id}` : ""}${hint}`
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
    text_preview: (ai.text || "").slice(0, 160)
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
        await send_text(from, "Mi amor, déjame confirmar ese producto con Winny y te lo muestro enseguida 💕");
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
