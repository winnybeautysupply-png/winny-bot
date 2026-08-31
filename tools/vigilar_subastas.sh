#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# Vigila la pagina de subastas de la DGA y avisa cuando publican
# un aviso NUEVO. Winny ya esta inscrita con la BARD, esto es la
# red de seguridad por si la bolsa no la llama.
#
#   ./tools/vigilar_subastas.sh            -> solo revisa e imprime
#   ./tools/vigilar_subastas.sh --avisar   -> ademas le manda WhatsApp
#
# Salidas:  SIN_CAMBIOS | PRIMERA_VEZ | NUEVOS (+ urls)   / exit 2 = error
# ═══════════════════════════════════════════════════════════════
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESTADO="$RAIZ/data/subastas_vistas.txt"
PAGINA="https://www.aduanas.gob.do/de-interes/subastas/"
AVISAR=0
[ "${1:-}" = "--avisar" ] && AVISAR=1

mkdir -p "$RAIZ/data"

html="$(curl -s --max-time 60 "$PAGINA")" || true
actual="$(printf '%s' "$html" \
  | grep -oiE 'href="[^"]*subasta[^"]*\.pdf"' \
  | sed -e 's/^[Hh][Rr][Ee][Ff]="//' -e 's/"$//' -e 's/&#xF3;/%C3%B3/g' \
  | sort -u)"

# Si no hay ni un aviso, algo se rompio (pagina caida o cambiaron el HTML).
# Preferimos avisar del fallo antes que quedarnos callados creyendo que no hay nada.
if [ -z "$actual" ]; then
  echo "ERROR: la pagina no devolvio ningun aviso"
  exit 2
fi

if [ ! -f "$ESTADO" ]; then
  printf '%s\n' "$actual" > "$ESTADO"
  echo "PRIMERA_VEZ: $(printf '%s\n' "$actual" | wc -l | tr -d ' ') avisos guardados como linea base"
  exit 0
fi

nuevos="$(comm -13 "$ESTADO" <(printf '%s\n' "$actual"))"

if [ -z "$nuevos" ]; then
  echo "SIN_CAMBIOS"
  exit 0
fi

printf '%s\n' "$actual" > "$ESTADO"

echo "NUEVOS:"
urls=""
while IFS= read -r ruta; do
  [ -z "$ruta" ] && continue
  u="https://www.aduanas.gob.do${ruta}"
  echo "$u"
  urls="${urls}${u}"$'\n'
done <<< "$nuevos"

[ "$AVISAR" -eq 1 ] && "$RAIZ/tools/avisar_duena.sh" "🏛️ *SUBASTA NUEVA DE ADUANAS*

Acaban de publicar un aviso nuevo en la pagina de la DGA:

${urls}
Llama a la bolsa (809) 565-7182 o a Aduanas (809) 364-0749 para inscribirte en los lotes.
La mercancia se puede ver lun-vie 9:00am-4:30pm en el almacen de El Higuero."

exit 0
