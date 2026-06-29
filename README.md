# 🌸 Winny Beauty Bot

Bot inteligente de WhatsApp para **Winny Beauty Supply** (Santo Domingo, RD).
Usa Claude AI (Anthropic) para responder en español dominicano cercano,
toma pedidos, recibe comprobantes de pago y escala a humano cuando es necesario.

## ✨ Funcionalidades

- 💬 Responde preguntas frecuentes (precios, ubicación, horarios, métodos de pago)
- 🛍️ Toma pedidos completos (producto, color, largo, cantidad, dirección)
- 🏦 Comparte cuentas bancarias para transferencia
- 📸 Recibe fotos de comprobantes de pago y los reenvía a Winny
- 🚨 Escala a humano cuando detecta queja, frustración o pregunta fuera de su scope
- 📊 Guarda historial de conversaciones (memoria contextual)
- 🕐 Sabe si el negocio está abierto o cerrado y ajusta sus respuestas

## 🏗️ Stack

- **Runtime:** Node.js 20+ (ESM)
- **Framework:** Express
- **AI:** Claude Sonnet 4.5 (Anthropic)
- **WhatsApp:** Cloud API (Meta) — modo NO verificado funciona perfectamente
- **DB:** SQLite (better-sqlite3) — sin instalación adicional
- **Logs:** Pino
- **Hosting recomendado:** Render Starter ($7/mes), Railway, o VPS Hetzner

## 🚀 Setup local

```bash
# 1. Clonar e instalar
cd winny-bot
npm install

# 2. Configurar variables
cp .env.example .env
# Llenar el .env con tus tokens reales

# 3. Probar Claude (sin necesidad de WhatsApp todavía)
npm run test-claude

# 4. Levantar el servidor
npm start
```

## 🔌 Conectar con Meta WhatsApp Cloud API

1. **Ir a [developers.facebook.com](https://developers.facebook.com)** → My Apps → Create App
2. Tipo: **Business** | Nombre: `Winny Beauty Bot`
3. Add Product → **WhatsApp**
4. En "API Setup":
   - Copiar `Phone number ID` → `.env` como `WHATSAPP_PHONE_NUMBER_ID`
   - Copiar `WhatsApp Business Account ID` → `.env`
   - Generar token temporal (24h) o ir a Business Settings → System Users para uno permanente
   - Token → `.env` como `WHATSAPP_ACCESS_TOKEN`
5. **Registrar tu número:** Add phone number → +1 829-383-9433 → verificar por SMS

## 🌐 Configurar el webhook en Meta

1. En Meta Developer App → WhatsApp → Configuration → Webhook
2. **Callback URL:** `https://TU-DOMINIO.com/webhook` (donde despliegues)
3. **Verify token:** el mismo que pusiste en `.env` como `WHATSAPP_VERIFY_TOKEN`
4. Click **Verify and save** → Meta llama a tu webhook con el token, el bot responde el challenge
5. **Subscribe to fields:** marcar `messages`

## 🚢 Deploy a producción

### Opción A — Render.com (más fácil, $7/mes)

1. Subir este repo a GitHub
2. Ir a [render.com](https://render.com) → New → Web Service
3. Conectar tu repo de GitHub
4. Render detecta `render.yaml` y configura todo automáticamente
5. En Environment, llenar los secrets que faltan:
   - `WHATSAPP_ACCESS_TOKEN`
   - `WHATSAPP_VERIFY_TOKEN`
   - `ANTHROPIC_API_KEY`
   - `BANK_ACCOUNTS`
6. Deploy → obtienes URL como `https://winny-beauty-bot.onrender.com`
7. Esa URL la pegas en el webhook de Meta

### Opción B — VPS (Hetzner $4.50/mes)

```bash
# En el VPS
ssh root@TU-IP
apt update && apt install -y nodejs npm git
git clone https://github.com/TU-USER/winny-bot.git
cd winny-bot
npm install
cp .env.example .env
nano .env  # llenar valores

# Correr con PM2 para que persista
npm install -g pm2
pm2 start src/index.js --name winny-bot
pm2 save
pm2 startup

# Configurar nginx + SSL con certbot para tener HTTPS
# (Meta exige HTTPS para webhooks)
```

### Opción C — Docker

```bash
docker build -t winny-bot .
docker run -d --name winny-bot \
  --env-file .env \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --restart unless-stopped \
  winny-bot
```

## 💰 Costos mensuales reales

| Concepto | Costo |
|---|---|
| Hosting Render Starter | $7 |
| Claude API (~200 msg/día) | $15-25 |
| WhatsApp conversations (free tier) | $0 |
| **TOTAL** | **~$22-32/mes** |

Si usas VPS Hetzner ($4.50) en lugar de Render: **~$20/mes**

## 🧪 Testing del flujo

Una vez desplegado, pruébalo desde tu propio WhatsApp:

```
Tú → Bot: "Hola"
Bot → Tú: "¡Hola mi amor! 💕 Bienvenida a Winny Beauty Supply..."

Tú → Bot: "Cuánto cuesta una peluca lace front rubia larga?"
Bot → Tú: "Las pelucas Lace Front cabello humano están entre RD$4,500 y RD$8,000..."

Tú → Bot: "Quiero hablar con Winny"
Bot → Tú: "Perfecto mi amor, le aviso a Winny ahora mismo..."
[Winny recibe notificación en su WhatsApp]
```

## 📁 Estructura del proyecto

```
winny-bot/
├── src/
│   ├── index.js              # Servidor Express + webhook
│   ├── config.js             # Variables de entorno
│   ├── logger.js             # Pino logger
│   ├── db.js                 # SQLite + queries
│   ├── whatsapp.js           # Cloud API helpers
│   ├── ai.js                 # Claude integration + tools
│   ├── prompts.js            # System prompt
│   ├── handlers/
│   │   └── messages.js       # Router principal
│   └── scripts/
│       ├── test-claude.js    # Probar Claude sin WhatsApp
│       └── init-db.js        # Forzar creación de tablas
├── data/
│   ├── winny-bot.db          # SQLite DB (auto-creada)
│   └── comprobantes/         # Fotos de pagos recibidos
├── .env.example
├── Dockerfile
├── render.yaml
└── package.json
```

## 🛡️ Seguridad

- ✅ Token de Meta y Claude SOLO en variables de entorno (nunca en código)
- ✅ `.env` está en `.gitignore`
- ✅ HTTPS obligatorio (Render lo da gratis, en VPS configurar nginx + certbot)
- ✅ Validación del verify_token en webhook GET
- ⚠️ **TODO:** validar firma `X-Hub-Signature-256` para mayor seguridad

## 📝 Tareas pendientes / mejoras futuras

- [ ] Validar firma del webhook (`X-Hub-Signature-256`)
- [ ] Transcribir audios con Whisper (OpenAI) para responder mensajes de voz
- [ ] OCR de comprobantes para pre-validar montos automáticamente
- [ ] Dashboard web simple para ver pedidos y conversaciones
- [ ] Integración con catálogo de winnybeautysupply.com (productos en tiempo real)
- [ ] Templates aprobados para mensajes proactivos (recordatorios, promociones)
- [ ] Reportes diarios automáticos a Winny (cuántos clientes, cuántos pedidos)

## 📞 Soporte

Bot construido por Claude (Anthropic) para Winny Mercedes Nuñez (2026-04-24).
Cualquier ajuste futuro: pasar este código a Claude y pedir lo que necesites.

## 📄 Licencia

Privado — solo para uso de Winny Beauty Supply EIRL (RNC 133178338).
