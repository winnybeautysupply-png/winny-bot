#!/usr/bin/env bash
# Manda un WhatsApp a Winny desde el numero del bot. Uso:
#   ./tools/avisar_duena.sh "texto del mensaje"
# Lee las credenciales de .env. No imprime secretos.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$RAIZ/.env" ] || { echo "ERROR: falta .env"; exit 2; }

leer() { grep -m1 -E "^$1=" "$RAIZ/.env" | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//'; }

SID="$(leer TWILIO_ACCOUNT_SID)"
KEY="$(leer TWILIO_API_KEY_SID)"
SEC="$(leer TWILIO_API_KEY_SECRET)"
FROM="$(leer TWILIO_WHATSAPP_NUMBER)"
TO="$(leer OWNER_PHONE)"
MSG="${1:-}"

[ -z "$MSG" ] && { echo "ERROR: falta el texto"; exit 2; }
case "$TO" in +*) ;; *) TO="+$TO";; esac

resp="$(curl -s --max-time 30 -u "$KEY:$SEC" \
  "https://api.twilio.com/2010-04-01/Accounts/$SID/Messages.json" \
  --data-urlencode "From=whatsapp:$FROM" \
  --data-urlencode "To=whatsapp:$TO" \
  --data-urlencode "Body=$MSG")"

if printf '%s' "$resp" | grep -q '"sid"'; then
  echo "ENVIADO"
else
  # El fallo mas comun es la ventana de 24h de WhatsApp: si Winny no le ha
  # escrito al bot hoy, Twilio rechaza el mensaje libre.
  echo "FALLO: $(printf '%s' "$resp" | head -c 400)"
  exit 1
fi
