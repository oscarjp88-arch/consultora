#!/usr/bin/env bash
# =============================================================================
# Auditoría de selectores de tienda — Creditek ERP
# Ejecutar desde la raíz del repo:  bash auditoria_selectores_tiendas.sh
# =============================================================================
# Objetivo:
#   Detectar pantallas que arman <select> de tiendas consultando `origenes`
#   sin filtrar por tipo, lo que haría aparecer CENTRAL como opción operativa.
#
# Salida:
#   Tres bloques — 🔴 PROBLEMÁTICOS, 🟡 REVISAR, 🟢 OK — con archivo:línea.
# =============================================================================

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Colores
RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; BLU='\033[0;34m'; NC='\033[0m'

echo -e "${BLU}=== Auditoría de selectores de tienda — origenes ===${NC}"
echo "Repo: $(pwd)"
echo ""

# 1) TODAS las referencias a la tabla `origenes` en JS/HTML
echo -e "${BLU}[1/3] Buscando todas las referencias a 'origenes' en archivos JS/HTML...${NC}"
MATCHES=$(grep -rn --include='*.html' --include='*.js' --include='*.ts' -E "from\(['\"]origenes['\"]" . 2>/dev/null || true)
if [ -z "$MATCHES" ]; then
  echo "  (ninguna referencia encontrada — ¿ejecutaste desde la raíz correcta?)"
  exit 0
fi
COUNT=$(echo "$MATCHES" | wc -l | tr -d ' ')
echo "  $COUNT referencias encontradas."
echo ""

# 2) Clasificar por patrón — leer 15 líneas después de cada match y ver qué filtros aplica
declare -a PROBLEMATICOS
declare -a REVISAR
declare -a OK

TMP_REPORT=$(mktemp)
echo "$MATCHES" | while IFS=: read -r file linea resto; do
  # Extraer bloque de contexto (líneas siguientes a la referencia)
  CTX=$(sed -n "${linea},$((linea+15))p" "$file" 2>/dev/null)

  # Heurística de clasificación
  TIENE_ACTIVO=$(echo "$CTX" | grep -c "activo" || true)
  TIENE_TIPO=$(echo "$CTX"   | grep -cE "\.eq\(['\"]tipo['\"]|\.in\(['\"]tipo['\"]|tipo.*propia" || true)
  TIENE_CENTRAL_EXCL=$(echo "$CTX" | grep -cE "neq\(['\"]tipo['\"],\s*['\"]central|neq\(['\"]codigo['\"],\s*['\"]CENTRAL|!=.*CENTRAL" || true)

  # Uso funcional (¿se usa para armar un select de tiendas operativas?)
  USO_SELECT=$(echo "$CTX" | grep -cE "<select|createElement\(['\"]select|<option|tienda_codigo|tienda_destino|selectedTienda|origen_codigo" || true)

  if [ "$USO_SELECT" -gt 0 ] || echo "$file" | grep -qE "(ventas|caja|traslado|selector|tienda|origen)"; then
    if [ "$TIENE_TIPO" -eq 0 ] && [ "$TIENE_CENTRAL_EXCL" -eq 0 ]; then
      echo "PROBLEMATICO|$file|$linea|$CTX" >> "$TMP_REPORT"
    elif [ "$TIENE_TIPO" -gt 0 ] || [ "$TIENE_CENTRAL_EXCL" -gt 0 ]; then
      echo "OK|$file|$linea|$CTX" >> "$TMP_REPORT"
    else
      echo "REVISAR|$file|$linea|$CTX" >> "$TMP_REPORT"
    fi
  else
    echo "REVISAR|$file|$linea|$CTX" >> "$TMP_REPORT"
  fi
done

# 3) Reporte
echo -e "${RED}🔴 PROBLEMÁTICOS — filtran solo activo=true, sin tipo (CENTRAL aparecerá):${NC}"
grep '^PROBLEMATICO|' "$TMP_REPORT" | awk -F'|' '{ printf "   %s:%s\n", $2, $3 }' || echo "   (ninguno detectado)"
echo ""
echo -e "${YEL}🟡 REVISAR MANUALMENTE — patrón no clasificable automáticamente:${NC}"
grep '^REVISAR|' "$TMP_REPORT" | awk -F'|' '{ printf "   %s:%s\n", $2, $3 }' || echo "   (ninguno)"
echo ""
echo -e "${GRN}🟢 YA CORRECTOS — filtran tipo o excluyen CENTRAL explícitamente:${NC}"
grep '^OK|' "$TMP_REPORT" | awk -F'|' '{ printf "   %s:%s\n", $2, $3 }' || echo "   (ninguno)"

echo ""
echo -e "${BLU}=== Fix template ===${NC}"
cat << 'EOF'

Reemplaza el patrón:

    supabase.from('origenes')
      .select('codigo, nombre')
      .eq('activo', true)
      .order('codigo')

por:

    supabase.from('origenes')
      .select('codigo, nombre')
      .eq('activo', true)
      .eq('tipo', 'propia')            // ← solo tiendas propias, excluye CENTRAL y aliadas
      .order('codigo')

O más robusto — usa la vista defensiva `tiendas_operativas` (ver migración
r5_view_tiendas_operativas): ya filtra por ti y no puedes olvidarla:

    supabase.from('tiendas_operativas')
      .select('codigo, nombre')
      .order('codigo')

EOF

rm -f "$TMP_REPORT"
