#!/usr/bin/env bash
# =============================================================================
# apply_migracion_links.sh — reemplaza URLs absolutas de GH Pages por
# rutas root-relativas, listo para servirse desde Cloudflare Pages.
#
# Ejecutar desde la raíz del repo `consultora`:
#   bash apply_migracion_links.sh
#
# NO se ejecuta automáticamente en el sandbox de Cowork — Oscar lo corre
# en Fase 2, DESPUÉS de verificar que el proyecto CF Pages funciona en
# la URL `.pages.dev`.
#
# Cambios:
#   1) auditoria-cruzada.html:316 — share link con location.origin
#      (mano, para no romper el share por WhatsApp)
#   2) sed global para todos los HTML/JS: quita el prefijo absoluto
#   3) Recordatorio de CORS del Worker pdf-combiner (NO se toca automático,
#      requiere que Oscar decida dominio final)
# =============================================================================

set -euo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

RED='\033[0;31m'; YEL='\033[1;33m'; GRN='\033[0;32m'; BLU='\033[0;34m'; NC='\033[0m'

echo -e "${BLU}=== Migración GH Pages → Cloudflare Pages · aplicar links ===${NC}"
echo "Repo: $(pwd)"
echo ""

# ----------------------------------------------------------------------------
# Sanity check — trabajar en un working tree limpio (o al menos advertir)
# ----------------------------------------------------------------------------
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${YEL}⚠️  Working tree con cambios sin comitear:${NC}"
  git status --short
  echo ""
  read -p "¿Continuar de todas formas? (s/N): " confirm
  [ "$confirm" != "s" ] && [ "$confirm" != "S" ] && exit 1
fi

# ----------------------------------------------------------------------------
# PASO 1 · Fix manual del share link en auditoria-cruzada.html
# ----------------------------------------------------------------------------
echo -e "${BLU}[1/3] Fix share link (auditoria-cruzada.html:316)...${NC}"

FILE_AUDIT="creditek/erp/auditoria-cruzada.html"
if [ ! -f "$FILE_AUDIT" ]; then
  echo -e "${RED}❌ No encuentro $FILE_AUDIT — abortando.${NC}"; exit 1
fi

# Cambia la asignación del link a usar location.origin (no root-relative,
# porque este link se comparte por WhatsApp y necesita protocolo+dominio).
sed -i.bak "s|https://oscarjp88-arch\.github\.io/consultora/creditek/erp/cierre-periodo\.html?sesion=\${sesionId}|\${location.origin}/creditek/erp/cierre-periodo.html?sesion=\${sesionId}|" "$FILE_AUDIT"

# Verificar que el cambio se aplicó (grep debe mostrar location.origin)
if grep -q 'location\.origin.*cierre-periodo' "$FILE_AUDIT"; then
  echo -e "  ${GRN}✓ Aplicado. Backup en $FILE_AUDIT.bak${NC}"
else
  echo -e "  ${RED}❌ El sed no matcheó — puede que la línea haya cambiado. Revisar manualmente.${NC}"
  mv "$FILE_AUDIT.bak" "$FILE_AUDIT"
  exit 1
fi

# ----------------------------------------------------------------------------
# PASO 2 · Sed global · URLs absolutas → root-relative
# ----------------------------------------------------------------------------
echo -e "${BLU}[2/3] Sed global sobre HTML/JS/JSON/MD/TS...${NC}"

# Contar refs antes
BEFORE=$(grep -rln "https://oscarjp88-arch.github.io/consultora" \
  --include="*.html" --include="*.js" --include="*.ts" --include="*.json" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler \
  --exclude-dir=.playwright-mcp \
  . 2>/dev/null | wc -l | tr -d ' ')

echo "  Archivos con la URL antes: $BEFORE"

# Aplicar sed. Usa un divisor '|' porque el patrón tiene '/'. Genera .bak para rollback.
find . \
  -type f \
  \( -name "*.html" -o -name "*.js" -o -name "*.ts" -o -name "*.json" -o -name "*.md" \) \
  -not -path "./node_modules/*" \
  -not -path "./.git/*" \
  -not -path "./.wrangler/*" \
  -not -path "./.playwright-mcp/*" \
  -not -path "./creditek/*/node_modules/*" \
  -not -path "./creditek/workers/*/.wrangler/*" \
  -exec sed -i.bak "s|https://oscarjp88-arch\.github\.io/consultora||g" {} +

# Contar refs después
AFTER=$(grep -rln "https://oscarjp88-arch.github.io/consultora" \
  --include="*.html" --include="*.js" --include="*.ts" --include="*.json" --include="*.md" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler \
  --exclude-dir=.playwright-mcp \
  . 2>/dev/null | wc -l | tr -d ' ')

echo -e "  ${GRN}✓ Archivos con la URL después: $AFTER (esperado: 0 en fuentes del repo)${NC}"

if [ "$AFTER" -gt 0 ]; then
  echo -e "  ${YEL}⚠️  Quedan referencias — probablemente en directorios excluidos o en variantes de URL:${NC}"
  grep -rln "https://oscarjp88-arch.github.io/consultora" \
    --include="*.html" --include="*.js" --include="*.ts" --include="*.json" --include="*.md" \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.wrangler \
    --exclude-dir=.playwright-mcp \
    .
fi

# ----------------------------------------------------------------------------
# PASO 3 · Recordatorio del CORS del Worker
# ----------------------------------------------------------------------------
echo ""
echo -e "${YEL}[3/3] RECORDATORIO manual — CORS del Worker pdf-combiner${NC}"
echo ""
echo "  El archivo creditek/workers/pdf-combiner/index.js:28 tiene:"
echo "    const ALLOWED_ORIGIN = 'https://oscarjp88-arch.github.io';"
echo ""
echo "  Necesita convertirse en el dominio real de CF Pages (o el custom"
echo "  domain que hayas elegido para el frontend). Ejemplo:"
echo "    const ALLOWED_ORIGIN = 'https://erp.crediteksas.com';"
echo ""
echo "  Y después:"
echo "    cd creditek/workers/pdf-combiner && wrangler deploy"
echo ""

# ----------------------------------------------------------------------------
# Limpiar .bak
# ----------------------------------------------------------------------------
echo -e "${BLU}Limpiando .bak (backups de sed)...${NC}"
find . -type f -name "*.bak" \
  -not -path "./node_modules/*" -not -path "./.git/*" \
  -not -path "./.wrangler/*" -not -path "./.playwright-mcp/*" \
  -delete
echo -e "  ${GRN}✓ Backups eliminados. Rollback: usar git checkout o git restore.${NC}"

echo ""
echo -e "${GRN}=== Fase 2 pasos 1-2 completos ===${NC}"
echo "Falta paso 3 (CORS del Worker). Comitea cuando estés seguro:"
echo "  git diff --stat"
echo "  git add -A && git commit -m 'chore: migración GH Pages → CF Pages, URLs a root-relative'"
