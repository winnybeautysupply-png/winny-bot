process.env.DB_PATH = process.env.DB_PATH || "./data/prueba-wacfg.db";
await import("../apartados.js"); // crea la tabla settings
const W = await import("../wa_config.js");
const C = await import("../whatsapp_cloud.js");
const ok=(n,c)=>console.log(`${c?"✅":"❌"}  ${n}`);
ok("Arranca sin conexión", C.cloud_enabled() === false);
ok("No muestra token", W.wa_estado().tiene_token === false);
W.wa_guardar({ phone_number_id:"123456789012345", waba_id:"1136998529079088", token:"EAABsbCS1iHgBO123456789abcdef" }, "Winny");
ok("Guardó los tres datos", W.wa_cfg().phone_number_id === "123456789012345");
ok("El bot YA se considera conectado, sin reiniciar", C.cloud_enabled() === true);
const e = W.wa_estado();
ok("Tapa el token en pantalla", e.token_tapado.includes("•") && !e.token_tapado.includes("123456789abcdef"));
ok("Marca listo", e.listo === true);
W.wa_guardar({ phone_number_id:"999" }, "Winny");
ok("Guardar un solo campo NO borra el token", W.wa_cfg().token.startsWith("EAABsbCS"));
ok("...y sí actualiza el que mandó", W.wa_cfg().phone_number_id === "999");
W.wa_borrar("Winny");
ok("Se puede desconectar todo", C.cloud_enabled() === false);
