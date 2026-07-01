// ═══════════════════════════════════════════════════════════════
// Claude AI — genera respuestas inteligentes en español dominicano
// ═══════════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { SYSTEM_PROMPT, OWNER_PROMPT } from "./prompts.js";
import { catalog_summary } from "./catalog.js";
import { logger } from "./logger.js";

// timeout + reintentos: si Claude responde lento o falla puntualmente, no cuelga el bot.
const claude = new Anthropic({ apiKey: config.claude.api_key, timeout: 45000, maxRetries: 2 });

// Tools que Claude puede llamar para acciones especiales
const TOOLS = [
  {
    name: "escalar_a_winny",
    description: "Notifica a Winny (humano) que el cliente necesita atención personal. Usar cuando el cliente pide hablar con persona, hace reclamo, pregunta algo fuera de tu conocimiento, pregunta por descuentos/cupones/ofertas específicas, o cuando detectes frustración.",
    input_schema: {
      type: "object",
      properties: {
        razon: { type: "string", description: "Por qué se está escalando (1 línea)" },
        urgencia: { type: "string", enum: ["baja", "media", "alta"], description: "Nivel de urgencia" }
      },
      required: ["razon", "urgencia"]
    }
  },
  {
    name: "registrar_pedido",
    description: "Cuando el cliente confirma todos los datos de un pedido (producto, cantidad, nombre, dirección, método pago), llama esta función para guardarlo en el sistema.",
    input_schema: {
      type: "object",
      properties: {
        productos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              nombre: { type: "string" },
              detalles: { type: "string", description: "color/largo/tipo" },
              cantidad: { type: "number" },
              precio_unitario_rd: { type: "number" }
            },
            required: ["nombre", "cantidad"]
          }
        },
        nombre_cliente: { type: "string" },
        direccion: { type: "string" },
        metodo_pago: { type: "string", enum: ["efectivo", "tarjeta", "transferencia", "contra_entrega"] },
        notas: { type: "string", description: "Comentarios adicionales del cliente" }
      },
      required: ["productos", "nombre_cliente", "direccion", "metodo_pago"]
    }
  },
  {
    name: "compartir_cuentas_bancarias",
    description: "Envía las cuentas bancarias al cliente cuando elige pagar por transferencia.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "mostrar_producto",
    description: "Cuando la clienta describe un producto que quiere ver (ej. 'peluca rizada', 'set de maquillaje', 'pelo piano'), llama esta función con esa descripción. El sistema busca en el catálogo y le manda a la clienta la FOTO/VIDEO del producto con su nombre y precio. Úsala cuando pregunten por un producto o pidan ver fotos/videos.",
    input_schema: {
      type: "object",
      properties: {
        descripcion: { type: "string", description: "Lo que busca la clienta, ej: 'peluca rizada negra', 'set brochas'" }
      },
      required: ["descripcion"]
    }
  },
  {
    name: "mostrar_ofertas",
    description: "Cuando la clienta pide ver las OFERTAS o promociones, llama esta función (sin parámetros). El sistema le manda las fotos/videos de los productos en oferta con sus precios.",
    input_schema: { type: "object", properties: {} }
  }
];

// Tool para EXTRAER los datos de un pedido de una conversación (para la factura)
const EXTRACT_TOOL = {
  name: "datos_pedido",
  description: "Extrae los datos del pedido de esta conversación de WhatsApp para generar la factura.",
  input_schema: {
    type: "object",
    properties: {
      hay_pedido: { type: "boolean", description: "true SOLO si en la conversación hay un pedido identificable con productos que la clienta quiere comprar" },
      nombre_cliente: { type: "string", description: "nombre de la clienta si se menciona" },
      direccion: { type: "string", description: "dirección de envío si se menciona" },
      productos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            nombre: { type: "string" },
            detalles: { type: "string", description: "color/largo/tipo" },
            cantidad: { type: "number" },
            precio_unitario_rd: { type: "number", description: "precio unitario en RD$ según la conversación" }
          },
          required: ["nombre", "cantidad"]
        }
      },
      envio_rd: { type: "number", description: "costo de envío en RD$ si se mencionó; si no, 0" }
    },
    required: ["hay_pedido", "productos"]
  }
};

/**
 * Extrae los datos del pedido de una conversación, para armar la factura cuando
 * el pedido no quedó registrado formalmente (ej. la venta pasó por handoff).
 * @param {Array} history - [{role, content}]
 * @returns {Object|null} - {nombre_cliente, direccion, productos, envio_rd} o null
 */
export async function extract_order_from_chat(history = []) {
  if (!history.length) return null;
  const convo = history
    .map(m => `${m.role === "user" ? "Clienta" : "Winny/Bot"}: ${m.content}`)
    .join("\n");
  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 600,
      temperature: 0,
      system: "Extraes datos de pedidos de Winny Beauty Supply (extensiones de cabello humano, pelucas, accesorios) de una conversación de WhatsApp, para generar una factura. Usa los productos y precios que se mencionen en la conversación. Si no hay un pedido claro con productos, pon hay_pedido=false.",
      tools: [EXTRACT_TOOL],
      tool_choice: { type: "tool", name: "datos_pedido" },
      messages: [{ role: "user", content: `Conversación:\n\n${convo}\n\nExtrae el pedido para la factura.` }]
    });
    const block = response.content.find(b => b.type === "tool_use");
    if (!block) return null;
    const d = block.input;
    if (!d.hay_pedido || !Array.isArray(d.productos) || d.productos.length === 0) return null;
    return d;
  } catch (err) {
    logger.error({ err: err.message }, "Error extrayendo pedido del chat");
    return null;
  }
}

// ═══ VISIÓN — clasificar y describir una imagen que envía la clienta ═══
const IMAGE_CLASSIFY_TOOL = {
  name: "clasificar_imagen",
  description: "Clasifica y describe la imagen que envió una clienta de una tienda de pelucas y cabello.",
  input_schema: {
    type: "object",
    properties: {
      categoria: {
        type: "string",
        enum: [
          "comprobante_pago", "recibo", "factura", "documento",
          "peluca_producto", "cabello_peinado", "persona_con_peluca",
          "captura_conversacion", "captura_producto",
          "maniqui", "caja", "logo", "otro"
        ],
        description: "La categoría que MEJOR describe la imagen"
      },
      descripcion: { type: "string", description: "Qué se ve en la imagen, en español, 1-2 frases" },
      texto_visible: { type: "string", description: "Todo el texto legible en la imagen (montos, banco, nombre, etc.); vacío si no hay" },
      atributos_cabello: {
        type: "object",
        description: "Solo si se ve cabello/peluca",
        properties: {
          color: { type: "string" }, textura: { type: "string", description: "lacio/ondulado/rizado" },
          largo: { type: "string" }, tipo: { type: "string", description: "humano, sintético, piano, etc." }
        }
      },
      es_pago: { type: "boolean", description: "true SOLO si es claramente un comprobante/recibo/transferencia de PAGO" },
      confianza: { type: "number", description: "0 a 1, qué tan seguro estás de la categoría" }
    },
    required: ["categoria", "descripcion", "es_pago", "confianza"]
  }
};

/**
 * Analiza una imagen con visión y devuelve su clasificación estructurada.
 * @param {string} base64 - imagen en base64
 * @param {string} media_type - ej "image/jpeg"
 * @param {Array} history - [{role, content}] para contexto del chat
 * @returns {Object|null}
 */
export async function analyze_image(base64, media_type = "image/jpeg", history = []) {
  try {
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type, data: base64 } },
          { type: "text", text: "Clasifica y describe esta imagen que me envió una clienta. Si es un comprobante/recibo de pago o transferencia, márcalo. Si se ve cabello o peluca, describe color, textura, largo y tipo. Si es una captura o documento, lee el texto visible." }
        ]
      }
    ];
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 500,
      temperature: 0,
      system: "Eres un clasificador de visión para el WhatsApp de Winny Beauty Supply (tienda de pelucas y cabello humano en RD). Analizas imágenes que mandan las clientas y las clasificas con precisión. NO asumas que todo es un comprobante de pago: solo marca es_pago=true si REALMENTE ves un comprobante, recibo o transferencia bancaria.",
      tools: [IMAGE_CLASSIFY_TOOL],
      tool_choice: { type: "tool", name: "clasificar_imagen" },
      messages
    });
    const block = response.content.find(b => b.type === "tool_use");
    return block ? block.input : null;
  } catch (err) {
    logger.error({ err: err.message }, "Error analizando imagen (visión)");
    return null;
  }
}

// ═══ MODO JEFA — Winny (dueña) le da órdenes al bot ═══════════════
const OWNER_TOOLS = [
  {
    name: "enviar_mensaje_cliente",
    description: "Reenvía un mensaje a una clienta de parte del negocio, cuando Winny lo ordena (ej: 'dile a la clienta que...', 'escríbele que...').",
    input_schema: {
      type: "object",
      properties: {
        telefono: { type: "string", description: "número de la clienta (solo dígitos con código país, ej 18091234567) si Winny lo menciona; si no lo dice, dejar vacío para usar la última clienta con la que se habló" },
        mensaje: { type: "string", description: "el texto EXACTO que se le enviará a la clienta" }
      },
      required: ["mensaje"]
    }
  }
];

/**
 * Genera la respuesta del bot cuando WINNY (la dueña) le escribe (modo jefa).
 * @param {string} user_message - lo que escribió Winny
 * @param {Array} history - mensajes anteriores [{role, content}]
 * @returns {Object} - { text, tool_calls }
 */
export async function generate_owner_response(user_message, history = []) {
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: user_message }
  ];
  // Referencia de productos/precios/políticas para que el bot pueda RESPONDERLE a Winny
  // si ella le pregunta un precio o dato del negocio (NO para venderle ni tratarla como clienta).
  const ref_info =
    "\n\n═══ REFERENCIA DE PRODUCTOS, PRECIOS Y POLÍTICAS ═══\n" +
    "Usa esta información SOLO para responderle a Winny (la jefa) cuando te pregunte un precio o dato del negocio. " +
    "NO le hagas discurso de venta ni la trates como clienta. Solo dale el dato que pide, corto y directo.\n" +
    SYSTEM_PROMPT;
  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 500,
      temperature: 0.5,
      system: OWNER_PROMPT + ref_info,
      tools: OWNER_TOOLS,
      messages
    });
    let text = "";
    const tool_calls = [];
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") tool_calls.push({ name: block.name, input: block.input, id: block.id });
    }
    return { text: text.trim(), tool_calls };
  } catch (err) {
    logger.error({ err: err.message }, "Error en respuesta modo jefa");
    return { text: "Perdón jefa, tuve un problemita técnico 😅 ¿me lo repites?", tool_calls: [] };
  }
}

/**
 * Genera respuesta para un mensaje del cliente.
 * @param {string} user_message - lo que escribió el cliente
 * @param {Array} history - mensajes anteriores [{role: "user"|"assistant", content: "..."}]
 * @param {Object} ctx - contexto adicional (nombre, hora, etc.)
 * @returns {Object} - { text: string, tool_calls: [] }
 */
export async function generate_response(user_message, history = [], ctx = {}) {
  const ctx_text = ctx.is_open === false
    ? "\n\n[NOTA INTERNA: El negocio está cerrado ahora mismo. Si el cliente pregunta por horario, recordarle que abrimos mañana 9am.]"
    : "";

  // Inyectar el NOMBRE de la clienta (de su perfil de WhatsApp) para que el bot la trate por su nombre.
  const raw_name = (ctx.contact_name || "").trim();
  // Nombre "usable": tiene letras y no es un número/negocio raro. Si no, usamos "reina" como siempre.
  const looks_like_name = raw_name && /[a-záéíóúñ]/i.test(raw_name) && raw_name.replace(/[^\d]/g, "").length < raw_name.length / 2;
  const first_name = looks_like_name ? raw_name.split(/\s+/)[0] : "";
  const name_text = first_name
    ? `\n\n[NOTA INTERNA: El nombre de la clienta (según su WhatsApp) es "${first_name}". Trátala por su nombre de forma natural y cálida (ej: "Hola ${first_name} reina 💕", "claro ${first_name} mi amor"). NO la satures repitiéndolo en cada línea — úsalo en el saludo y de vez en cuando. Si el nombre parece un apodo raro, un negocio o emojis, ignóralo y usa "reina/mi amor". NUNCA le preguntes su nombre si ya lo tienes aquí.]`
    : "";

  // Inyectar el HISTORIAL DE COMPRAS para que el bot reconozca a la clienta que vuelve.
  const history_text = ctx.purchase_history
    ? `\n\n[NOTA INTERNA: Esta clienta YA te ha comprado antes. Su historial de compras:\n${ctx.purchase_history}\nReconócela con cariño como clienta que vuelve (ej: "¡Qué bueno tenerte de vuelta reina! 💕"). Puedes referirte a lo que compró antes si viene al caso (ej: preguntarle cómo le fue con su pelo, u ofrecerle algo que combine). Úsalo con naturalidad, NO se lo recites como una lista de robot.]`
    : "";

  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: user_message }
  ];

  // Inyectar el catálogo real (inventario) para que Claude conozca los productos
  let catalog_text = "";
  try {
    const cat = await catalog_summary();
    if (cat) catalog_text =
      `\n\n═══ CATÁLOGO CON FOTO/VIDEO (productos que puedes MOSTRAR con imagen) ═══\n${cat}\n\n` +
      `IMPORTANTE sobre las dos fuentes de info:\n` +
      `• Para PRECIOS, tu fuente oficial es la sección "PRODUCTOS Y PRECIOS" de más arriba (ahí están TODOS los precios: pelo, closures, frontales, PELUCAS, etc.). Da esos precios con confianza cuando la clienta pregunte.\n` +
      `• Los productos de esta lista de aquí son los que tienen FOTO/VIDEO: cuando la clienta quiera VER un producto, usa *mostrar_producto* (con la descripción). Si pide ofertas, usa *mostrar_ofertas*.\n` +
      `• Un producto puede tener precio en la lista de arriba aunque NO tenga foto aquí — en ese caso, dale el precio igual (solo no tendrás foto para mostrar).\n` +
      `• Solo ESCALA a Winny si un producto NO está ni en la lista de precios de arriba ni aquí. NUNCA inventes un precio que no esté en ninguna de las dos.`;
  } catch { /* si falla, sigue sin catálogo */ }

  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 600,
      temperature: 0.7,
      system: SYSTEM_PROMPT + catalog_text + ctx_text + name_text + history_text,
      tools: TOOLS,
      messages
    });

    // Extraer texto y llamadas a tools
    let text = "";
    const tool_calls = [];

    for (const block of response.content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        tool_calls.push({ name: block.name, input: block.input, id: block.id });
      }
    }

    logger.debug({ tool_calls: tool_calls.map(t => t.name), tokens: response.usage }, "Claude responded");

    return {
      text: text.trim(),
      tool_calls,
      usage: response.usage,
      stop_reason: response.stop_reason
    };
  } catch (err) {
    logger.error({ err: err.message }, "Error llamando Claude");
    // Fallback: respuesta genérica
    return {
      text: "Disculpa mi amor, tuve un problemita técnico 😅 ¿Me puedes repetir tu mensaje? O si prefieres hablar directo con Winny, dime y le aviso ✨",
      tool_calls: [],
      usage: null,
      stop_reason: "error"
    };
  }
}
