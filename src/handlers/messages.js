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
  get_pending_verification, get_latest_pending_verification
} from "../db.js";
import { generate_response } from "../ai.js";

// ═══ Helpers ═══════════════════════════════════════════════════

// Recuerda la última clienta que mandó ubicación (para cotizar su envío sin escribir el número)
let last_location_from = null;

function format_history(rows) {
  return rows.map(r => ({
    role: r.direction === "in" ? "user" : "assistant",
    content: r.content || ""
  }));
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

  const isConfirm = /^(confirmar|confirmo|confirmado|aprobar|aprobado)\b/.test(t)
    || /^pago\s+(confirmado|ok|llego|lleg[oó])/.test(t)
    || t === "ok" || t === "llego" || t === "llegó" || t === "ya llegó" || t === "ya llego";
  const isReject = /^(rechazar|rechazado|cancelar)\b/.test(t)
    || /^pago\s+(rechazado|no)/.test(t)
    || /^no\s+(lleg|ha llegado)/.test(t);
  if (isConfirm) return { action: "confirm", phone };
  if (isReject) return { action: "reject", phone };
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
    // Guardar el costo del envío en el pedido activo (si hay) para la factura
    const order = get_active_order(targetPhone) || get_pending_verification(targetPhone);
    if (order) {
      const prevNotes = order.notes ? `${order.notes} | ` : "";
      update_order(order.id, { notes: `${prevNotes}Envío: RD$${cmd.amount}` });
    }
    await send_text(targetPhone,
      `El envío a tu zona es de *RD$${cmd.amount}* mi amor 💕\nEste costo se suma a tu pedido. ¿Confirmas para coordinar el pago? ✨`);
    await send_text(owner,
      `✅ Le dije a la clienta (+${targetPhone}) que su envío es RD$${cmd.amount} 💕`);
    return true;
  }

  // ─── Confirmar / rechazar PAGO ───
  let targetPhone = cmd.phone;
  let order = targetPhone ? get_pending_verification(targetPhone) : get_latest_pending_verification();
  if (!targetPhone && order) targetPhone = order.phone;

  if (!targetPhone) {
    await send_text(owner,
      "No tengo ningún pago pendiente de confirmar ahora mismo mi reina 💕\n" +
      "Si quieres confirmar uno, mándame: *confirmar +1809XXXXXXX* (el número del cliente).");
    return true;
  }

  if (cmd.action === "confirm") {
    if (order) update_order(order.id, { status: "paid" });
    await send_text(targetPhone,
      "¡Tu pago fue confirmado mi amor! 💕✨\nYa preparamos tu pedido y te lo enviamos. ¡Gracias por tu compra! 🛍️");
    await send_text(owner,
      `✅ Pago confirmado${order?.customer_name ? ` de *${order.customer_name}*` : ""} (+${targetPhone}).\n` +
      `Ya le avisé a la clienta que su pedido va en camino 💕`);
  } else {
    if (order) update_order(order.id, { status: "payment_rejected" });
    await send_text(targetPhone,
      "Mi amor, todavía no nos ha llegado tu pago 😅\n¿Puedes verificar la transferencia o mandarme el comprobante de nuevo? Apenas confirmemos te enviamos tu pedido 💕");
    await send_text(owner,
      `❌ Le avisé a la clienta (+${targetPhone}) que el pago aún no ha llegado.`);
  }
  return true;
}

// ═══ Handler de TEXTO (lo más común) ═══════════════════════════

async function handle_text(parsed, contact) {
  const { from, text } = parsed;

  // Si está en handoff (humano atendiendo), no responder con bot
  if (is_handed_off(from)) {
    logger.info({ from }, "Cliente en handoff — bot no responde");
    return;
  }

  // Construir historial para Claude
  const history_rows = get_recent_messages(from, 10);
  const history = format_history(history_rows.slice(0, -1)); // excluir mensaje actual

  const ctx = {
    is_open: is_business_open(),
    contact_name: contact?.name
  };

  // Llamar a Claude
  const ai = await generate_response(text, history, ctx);

  // Procesar tool calls si los hay
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
      update_order(order.id, {
        status: "awaiting_payment",
        items: tool.input.productos || [],
        customer_name: tool.input.nombre_cliente,
        delivery_address: tool.input.direccion,
        payment_method: tool.input.metodo_pago,
        notes: tool.input.notas || ""
      });
      // Notificar a Winny del pedido
      const items_text = (tool.input.productos || [])
        .map(p => `• ${p.cantidad}× ${p.nombre}${p.detalles ? ` (${p.detalles})` : ""}`)
        .join("\n");
      await send_text(config.business.owner_phone,
        `🛍️ *Nuevo pedido* (#${order.id})\n\n` +
        `📱 +${from}\n` +
        `👤 ${tool.input.nombre_cliente}\n` +
        `📍 ${tool.input.direccion}\n` +
        `💳 ${tool.input.metodo_pago}\n\n` +
        `*Productos:*\n${items_text}\n\n` +
        (tool.input.notas ? `📝 ${tool.input.notas}\n` : "") +
        `\nEl bot ya le pidió el pago. Tú confirmas disponibilidad y total final 💕`
      );
    }
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

  save_message({
    phone: from, direction: "in", type,
    content: parsed.text || parsed.caption || "",
    media_path: null, wa_message_id: id
  });

  // Marcar como leído + indicador de typing
  try {
    await mark_read(id);
  } catch (e) { /* no critical */ }

  // ¿Es Winny (la dueña) mandando un comando de confirmación/rechazo de pago?
  // Si el texto parece comando, lo procesamos; si no, sigue como conversación normal
  // (así Winny también puede probar el bot como si fuera una clienta).
  if (is_owner(from) && (type === "text" || type === "interactive" || type === "button")) {
    try {
      const handled = await handle_owner_command(parsed);
      if (handled) return;
    } catch (err) {
      logger.error({ err: err.message, from }, "Error en comando de Winny");
    }
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
      // Por ahora solo notificamos; futuro: transcribir con Whisper
      await send_text(from, "Recibí tu audio mi amor 💕 Por ahora prefiero leer mensajes de texto, ¿me lo puedes escribir? O si prefieres hablar con Winny dime y le aviso ✨");
      set_handoff(from, 30);
      await notify_winny({
        from, contact_name: contact.name,
        reason: "Cliente envió audio — bot no procesa audio",
        urgency: "baja"
      });
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
