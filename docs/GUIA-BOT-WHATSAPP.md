# 🌸 Guía del Bot de WhatsApp — Winny Beauty Supply

Para Winny. Sin tecnicismos. Paso a paso.

---

## ¿Qué es esto?

Tu bot contesta solo a las clientas que te escriben al **849-545-3394**, tu
número de siempre. Les da precios, toma pedidos y te avisa cuando alguien
necesita hablar contigo.

**Tu WhatsApp del celular sigue funcionando igual.** Tú puedes seguir
escribiendo desde tu teléfono cuando quieras. El bot solo ayuda cuando tú
no estás.

**El bot no vive en tu computadora.** Vive en internet (en Render), así que
funciona aunque tu laptop esté apagada.

---

## 1. Conectar el bot (esto se hace UNA sola vez)

### Lo que hay que buscar en Meta

Entra a **https://business.facebook.com/wa/manage/** y busca
**Configuración de la API** (o *API Setup*).

Ahí copia tres cosas:

| Qué buscar | Cómo se ve |
|---|---|
| **Phone number ID** | Un número largo. **No** es tu teléfono. |
| **WhatsApp Business Account ID** | Otro número largo |
| **Token permanente** | Un texto largo que empieza con letras y números |

### Dónde se pegan

**En tu propio panel. No hace falta tocar Render ni nada técnico.**

1. Abre tu panel
2. Toca la pestaña **🤖 IA**
3. Arriba sale **"🔌 Conexión con Meta"** con tres cajitas
4. Pega cada dato y toca **Guardar**

Puedes llenarlas de a una. Lo que dejes vacío **no se borra**, así que
puedes pegar un dato hoy y otro mañana.

El bot los toma al instante — no hay que reiniciar nada.

> ⚠️ **El token es como la llave de tu negocio.** Pégalo sólo en tu
> panel. No lo mandes por WhatsApp ni se lo pases a nadie.

## 2. Avisarle a Meta dónde está el bot

En tu panel, pestaña **🤖 IA**, hay un recuadro que dice
**"📋 Lo que hay que pegar en Meta"** con los dos datos exactos, ya
escritos para ti. Cópialos de ahí.

En Meta, en la configuración del webhook de WhatsApp, pega:

| Campo | De dónde sale |
|---|---|
| **URL de devolución** | del recuadro de tu panel |
| **Token de verificación** | del recuadro de tu panel |

Después marca la casilla **messages** para que Meta te mande los mensajes.

Si dice **Verificado ✅**, quedó.

---

## 3. Encender la IA 🟢

1. Abre tu panel
2. Toca la pestaña **🤖 IA**
3. Toca **🟢 Encender la IA**

Listo. El bot empieza a contestar.

> El bot **arranca apagado siempre**. Nunca se enciende solo. Si lo quieres
> prendido, lo prendes tú.

---

## 4. Apagar la IA 🔴

Mismo lugar: pestaña **🤖 IA** → **🔴 Apagar la IA**.

**Importante: apagar la IA NO apaga el bot.**

Las clientas te siguen escribiendo y **sus mensajes siguen llegando a tu
Bandeja**. Lo único que se apaga son las respuestas automáticas. Tú
contestas a mano desde el panel.

**No pierdes ninguna clienta. Nunca.**

---

## 5. Ver cuánto estás gastando 💰

En esa misma pestaña **🤖 IA**, abajo, te dice:

- Cuántas respuestas van **hoy**
- Cuántas van **este mes**
- **Cuántas te quedan gratis**

**Meta te regala 1,000 respuestas al mes.** Después de esas empieza a
cobrar. El panel te avisa antes de que llegues.

Los mensajes que **tú** contestas a mano desde el celular **no se cobran**.

---

## 6. Poner el panel en tu celular 📲

Para que lo abras como una app, sin buscar el link:

1. Abre el panel en el navegador del celular
2. Toca la pestaña **📲 App**
3. Sigue lo que dice ahí (es "Agregar a pantalla de inicio")

Queda un ícono en tu celular como cualquier otra app.

---

## 7. Desconectar el número del todo

Si algún día quieres que el bot deje de tener acceso a tu número:

### Lo rápido (y suficiente casi siempre)
Pestaña **🤖 IA** → **🔴 Apagar la IA**. El bot deja de contestar al instante.

### Lo definitivo
1. Entra a **https://business.facebook.com/wa/manage/**
2. Busca la sección del **Webhook**
3. **Borra la URL** del webhook

Sin webhook, Meta deja de mandarle los mensajes al bot. Tu WhatsApp sigue
funcionando normal en tu celular — no pierdes nada.

---

## 8. Lo que el bot NUNCA hace

Estas reglas están metidas por dentro. **No se pueden apagar ni por error.**

| | |
|---|---|
| 🚫 | Nunca le escribe primero a nadie |
| 🚫 | Nunca manda mensajes masivos ni difusiones |
| ✅ | Solo contesta a quien te escribió a ti |
| ⏳ | Espera entre 5 y 20 segundos antes de contestar, mostrando "escribiendo…" |
| 1️⃣ | Una sola respuesta por mensaje recibido |
| 🛑 | Máximo 200 respuestas automáticas al día |
| 🙋 | Si alguien pide **"hablar con una persona"**, se calla 24 horas en ese chat y **te avisa al celular** |
| 🔗 | No manda enlaces en el primer mensaje a una clienta nueva |

---

## 9. Si algo sale mal

| Qué pasa | Qué hacer |
|---|---|
| **El bot no contesta** | Revisa la pestaña 🤖 IA: ¿está en verde? |
| **Sigue sin contestar** | En Meta, revisa que el webhook diga *Verificado* |
| **Contesta cosas raras** | Apágalo con el botón y avísame |
| **Contesta a destiempo** | Normal: espera 5 a 20 segundos a propósito |
| **No me llegan los avisos** | Pestaña 📲 App → activa las notificaciones |
| **Una clienta se queja** | Pestaña 🤖 IA → apagar → tú contestas a mano |

> **Ante la duda, apaga la IA.** Es un botón, es instantáneo, y no pierdes
> ningún mensaje. Siempre puedes volver a encenderla.

---

## 10. Lo que NO tienes que hacer nunca

- ❌ No escanees ningún código QR con este número
- ❌ No instales programas de WhatsApp "no oficiales"
- ❌ No pongas el token en ningún chat

Tu número está conectado por el **canal oficial de Meta**. Por eso **no hay
riesgo de que te lo bloqueen**. Cualquier atajo "gratis" que te ofrezcan por
QR sí tiene ese riesgo — y ahí te juegas el historial de todas tus clientas.
