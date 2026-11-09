# Conectar el bot de Winny a WhatsApp Cloud API

**Para quien haga la configuración.** Tiempo estimado: 20–30 minutos.
Winny no es técnica: ella solo necesita que esto quede funcionando.

---

## Lo que YA está hecho (no hay que tocarlo)

| | |
|---|---|
| **Número** | +1 849-545-3394 (Winny Beauty Supply) |
| **Estado en Meta** | Conectado · calidad **Alta** · 250 clientes/24h |
| **Socios / BSP** | **Ninguno** — está directo con Meta |
| **Coexistencia** | Activa: el WhatsApp del celular de Winny funciona normal |
| **WABA ID (probable)** | `1136998529079088` — confirmar |
| **Business ID** | `1598748394981298` (portafolio "Winny Beauty Supply 1") |
| **Bot** | Node 20 + Express, corriendo en Render |
| **Código del canal** | `src/whatsapp_cloud.js` + ruta `/wa/webhook` — **ya escrito y probado** |

⚠️ **Hay dos portafolios en esa cuenta de Meta.** El bueno es
`1598748394981298`. El otro (`1752219789316828`) está vacío — si ves
"Números de teléfono: se agregaron 0", estás en el equivocado.

---

## Lo que falta

### 1. App de Meta

1. https://developers.facebook.com → **My Apps** → **Create App**
2. Tipo: **Business**
3. Asociarla al portafolio **Winny Beauty Supply 1** (`1598748394981298`)
4. **Add Product** → **WhatsApp** → **Set up**
5. Vincular la WABA existente — **NO crear un número nuevo.**
   Debe aparecer el +1 849-545-3394 ya conectado.

> 🚨 **Importante:** no hacer ningún flujo que ofrezca "migrar" o
> "registrar" el número de nuevo. Está en Coexistencia y si se rompe,
> Winny pierde WhatsApp en su celular.

### 2. Datos a copiar

En **WhatsApp → API Setup**:

- **Phone number ID** → `WA_PHONE_NUMBER_ID`
- **WhatsApp Business Account ID** → `WA_BUSINESS_ACCOUNT_ID`

### 3. Token permanente

El token temporal de API Setup dura 24 horas. Hace falta uno permanente:

1. **Business Settings** → **Users** → **System Users** → **Add**
2. Rol: **Admin**
3. **Add Assets** → la app y la WABA → control total
4. **Generate New Token** → escoger la app → permisos:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copiar el token → `WA_CLOUD_TOKEN`

### 4. Variables en Render

Servicio del bot → **Environment**:

```
WA_PHONE_NUMBER_ID=<el de API Setup>
WA_BUSINESS_ACCOUNT_ID=<el de API Setup>
WA_CLOUD_TOKEN=<el token del System User>
WA_VERIFY_TOKEN=winny-wa-2026
WA_GRAPH_VERSION=v21.0
```

Guardar y esperar el redeploy.

> El canal está apagado mientras falten estas variables, así que el bot
> sigue funcionando como hoy hasta que estén puestas.

### 5. Webhook

En la app de Meta → **WhatsApp** → **Configuration** → **Webhook**:

| Campo | Valor |
|---|---|
| **Callback URL** | `https://<el-servicio>.onrender.com/wa/webhook` |
| **Verify token** | `winny-wa-2026` |

Suscribirse al campo **`messages`**.

La ruta `GET /wa/webhook` ya responde el `hub.challenge`; la verificación
debe pasar a la primera.

---

## Cómo comprobar que quedó

```bash
# 1. La verificación del webhook responde el challenge
curl "https://<servicio>.onrender.com/wa/webhook?hub.mode=subscribe&hub.verify_token=winny-wa-2026&hub.challenge=OK123"
# -> OK123

# 2. Las pruebas del repo pasan
npm run test-antiban && npm run test-cloud && npm run test-frases && npm run test-interruptor
```

Después: Winny entra al panel → pestaña **🤖 IA** → **Encender la IA**, y
alguien le escribe al 849-545-3394 desde otro teléfono.

**El bot tarda de 5 a 20 segundos en responder a propósito** (regla
anti-spam), mostrando "escribiendo…" mientras tanto. No es un error.

---

## Cosas que NO hay que hacer

- ❌ **No** escanear ningún QR con ese número
- ❌ **No** usar Evolution API, WAHA, WPPConnect ni nada por QR —
  el número de Winny tiene todo su historial de clientas
- ❌ **No** migrar el número a "API only": perdería WhatsApp en el celular
- ❌ **No** poner el token en el código ni en el repo — solo en Render
- ❌ **No** tocar el canal de Twilio existente: sigue ahí y es otro número

---

## Contexto del código (por si hace falta mirarlo)

- Rama: `claude/alibaba-refund-case-jessica-0etqi4`
- `src/whatsapp_cloud.js` — cliente de Cloud API (enviar, recibir,
  "escribiendo…", marcar leído, subir y bajar media)
- `src/antiban.js` — las seis reglas que Winny pidió + cuota de los
  1,000 mensajes gratis mensuales de Meta
- `src/interruptor.js` — encender/apagar la IA desde el panel
- `src/index.js` — ruta `/wa/webhook`
- `src/whatsapp.js` — despacha a Twilio o a Meta según el canal del
  mensaje entrante, por eso los 11 archivos que lo importan no cambiaron

Los mensajes entrantes se guardan **siempre**, aunque el bot no conteste,
para que Winny los vea en el panel y no pierda clientas.
