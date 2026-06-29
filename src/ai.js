// ═══════════════════════════════════════════════════════════════
// Claude AI — genera respuestas inteligentes en español dominicano
// ═══════════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { SYSTEM_PROMPT, OWNER_PROMPT } from "./prompts.js";
import { logger } from "./logger.js";

const claude = new Anthropic({ apiKey: config.claude.api_key });

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
  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 500,
      temperature: 0.5,
      system: OWNER_PROMPT,
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

  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: user_message }
  ];

  try {
    const response = await claude.messages.create({
      model: config.claude.model,
      max_tokens: 600,
      temperature: 0.7,
      system: SYSTEM_PROMPT + ctx_text,
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
