// ═══════════════════════════════════════════════════════════════
// Claude AI — genera respuestas inteligentes en español dominicano
// ═══════════════════════════════════════════════════════════════
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { SYSTEM_PROMPT } from "./prompts.js";
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
