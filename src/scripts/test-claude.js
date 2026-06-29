// ═══════════════════════════════════════════════════════════════
// Script de prueba — verifica que Claude API funcione
// Correr con: npm run test-claude
// ═══════════════════════════════════════════════════════════════
import { generate_response } from "../ai.js";

const test_messages = [
  "Hola, cuánto cuesta una peluca?",
  "Tienen pelo rizado largo en castaño?",
  "Quiero hacer un pedido de 2 pelucas Lace Front rubias largas. Mi nombre es María Pérez, dirección Calle Duarte 45, Santo Domingo. Pago por transferencia.",
  "Cuál es la dirección de la tienda?",
  "Quiero hablar con Winny por favor",
  "Acabo de pagar, ya te mando el comprobante"
];

async function run() {
  console.log("🧪 Probando Claude AI con mensajes típicos...\n");

  for (const msg of test_messages) {
    console.log("━".repeat(60));
    console.log(`👤 Cliente: ${msg}`);
    const result = await generate_response(msg, [], { is_open: true });
    console.log(`🤖 Bot: ${result.text}`);
    if (result.tool_calls.length > 0) {
      console.log(`🔧 Tools: ${result.tool_calls.map(t => t.name).join(", ")}`);
      result.tool_calls.forEach(t => {
        console.log(`   ${t.name}:`, JSON.stringify(t.input, null, 2));
      });
    }
    console.log(`📊 Tokens: in=${result.usage?.input_tokens} out=${result.usage?.output_tokens}`);
    console.log();
  }

  console.log("✅ Pruebas completadas");
}

run().catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
