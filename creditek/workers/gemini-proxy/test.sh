#!/usr/bin/env bash
# Creditek Worker — Test Suite & Regression Detector
#
# Uso:
#   ./test.sh              — ejecutar tests y comparar con baseline guardado
#   ./test.sh --baseline   — ejecutar tests Y guardar estado como nuevo baseline
#   ./test.sh --revert     — si hay regresión, revertir deploy automáticamente
#
# Salida: exit 0 si pasan todos, exit 1 si hay falla o regresión.

set -uo pipefail

WORKER="https://creditek-gemini-proxy.comercial-853.workers.dev"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || echo "$SCRIPT_DIR/../../..")"
BASELINE="$SCRIPT_DIR/test-baseline.json"
TMP_REFS="$(mktemp)"
TMP_PY="$(mktemp).py"
trap "rm -f '$TMP_REFS' '$TMP_PY'" EXIT

RED='\033[0;31m'; GRN='\033[0;32m'; YEL='\033[1;33m'
CYN='\033[0;36m'; BLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

SAVE_BASELINE=false
REVERT_ON_FAIL=false
for arg in "$@"; do
  [[ "$arg" == "--baseline" ]] && SAVE_BASELINE=true
  [[ "$arg" == "--revert"   ]] && REVERT_ON_FAIL=true
done

PASS=0; FAIL=0
pass() { echo -e "  ${GRN}✓${NC} $1"; PASS=$((PASS+1)); }
fail() { echo -e "  ${RED}✗${NC} $1"; FAIL=$((FAIL+1)); }

echo -e "\n${BLD}══════════════════════════════════════════════════════${NC}"
echo -e "${BLD}  Creditek Worker — Test Suite  $(date '+%Y-%m-%d %H:%M:%S')${NC}"
echo -e "${BLD}══════════════════════════════════════════════════════${NC}\n"

# ──────────────────────────────────────────────────────────────────────
# 1. /health
# ──────────────────────────────────────────────────────────────────────
echo -e "${BLD}1. GET /health${NC}"

HEALTH="$(curl -sf --max-time 12 "$WORKER/health" 2>/dev/null)" || {
  fail "Worker no responde (timeout o error de red)"
  exit 1
}

if [[ "$(echo "$HEALTH" | jq -r '.ok' 2>/dev/null)" == "true" ]]; then
  pass "ok: true"
else
  fail "ok no es true → $HEALTH"
fi

# ──────────────────────────────────────────────────────────────────────
# 2. /brand-references — conteo y clasificación
# ──────────────────────────────────────────────────────────────────────
echo -e "\n${BLD}2. GET /brand-references${NC}"

HTTP_CODE="$(curl -sf --max-time 90 -o "$TMP_REFS" -w "%{http_code}" "$WORKER/brand-references" 2>/dev/null)" || {
  fail "Sin respuesta de /brand-references"
  exit 1
}

if [[ "$HTTP_CODE" != "200" ]]; then
  fail "HTTP $HTTP_CODE — esperado 200"
  exit 1
fi

# Toda la lógica de análisis vive en este script Python
cat > "$TMP_PY" << 'PYEOF'
#!/usr/bin/env python3
import sys, json, os
from datetime import datetime

RED = '\033[0;31m'; GRN = '\033[0;32m'; YEL = '\033[1;33m'
CYN = '\033[0;36m'; BLD = '\033[1m';    DIM = '\033[2m';    NC = '\033[0m'

refs_file = sys.argv[1]
bl_file   = sys.argv[2]
save_bl   = sys.argv[3] == 'true'
commit    = sys.argv[4]

with open(refs_file) as f:
    data = json.load(f)

results     = data.get('results', [])
financieras = data.get('financieras', {})
EXPECTED    = 12
total       = len(results) + len(financieras)

# ── 2a. Total marcas ─────────────────────────────────────────────────
if total == EXPECTED:
    print(f"PASS_TOTAL=Total: {total} ({len(results)} celulares + {len(financieras)} financieras)")
else:
    print(f"FAIL_TOTAL=Total: {total} — esperado {EXPECTED} ({len(results)} celulares + {len(financieras)} financieras)")

# ── 2b. Clasificar cada marca ─────────────────────────────────────────
def classify(r):
    url    = r.get('url', '')
    status = r.get('status', 0)
    n      = len(r.get('modelos', []))
    if url == 'static':                           return 'static', n
    if url in ('google-shopping', 'amazon-mx'):   return url, n
    if url and status == 200 and n > 0:            return 'live', n
    return 'static', n

LEVELS = {'live': 3, 'google-shopping': 2, 'amazon-mx': 2, 'static': 1}

brand_state = {}   # marca → {'src': str, 'models': int}

print(f"\n  {BLD}Marcas de celulares:{NC}")
for r in results:
    marca = r.get('marca', '')
    src, n = classify(r)
    brand_state[marca] = {'src': src, 'models': n}
    if src == 'live':
        dot = f"{GRN}●{NC}"
    elif src in ('google-shopping', 'amazon-mx'):
        dot = f"{YEL}●{NC}"
    else:
        dot = f"{CYN}●{NC}"
    print(f"  {dot} {marca:<22s} {src:<18s} {n:>2d} modelos")

print(f"\n  {BLD}Financieras:{NC}")
for nombre, info in financieras.items():
    print(f"  {CYN}●{NC} {nombre:<22s} {info.get('tagline','')[:50]}")

# ── 2c. Comparar con baseline ─────────────────────────────────────────
regression = False

if os.path.exists(bl_file):
    print(f"\n  {BLD}Regresiones vs baseline:{NC}")
    with open(bl_file) as f:
        bl = json.load(f)
    bl_brands = bl.get('brands', {})
    bl_commit  = bl.get('commit', 'desconocido')[:8]

    for marca, state in brand_state.items():
        src = state['src']
        n   = state['models']

        if marca not in bl_brands:
            print(f"  {YEL}+{NC} {marca} — nuevo (no estaba en baseline)")
            continue

        bl_src    = bl_brands[marca]['src']
        bl_models = bl_brands[marca]['models']
        cur_lvl   = LEVELS.get(src, 1)
        bl_lvl    = LEVELS.get(bl_src, 1)

        if cur_lvl < bl_lvl:
            print(f"  {RED}▼ REGRESION  {marca}: era {bl_src}/{bl_models} modelos → ahora {src}/{n}{NC}")
            regression = True
        elif cur_lvl > bl_lvl:
            print(f"  {GRN}▲ MEJORA     {marca}: era {bl_src}/{bl_models} → ahora {src}/{n}{NC}")
        elif n < bl_models:
            print(f"  {YEL}↓ MENOS DATOS{NC} {marca}: {bl_models} → {n} modelos (source: {src})")
        else:
            print(f"  {GRN}✓{NC} {marca:<22s} sin cambios ({src}, {n} modelos)")

    print(f"\n  {DIM}Baseline: commit {bl_commit}  •  {bl.get('timestamp','?')[:10]}{NC}")
else:
    print(f"\n  {DIM}(sin baseline guardado — usa --baseline para guardar el estado actual){NC}")

if regression:
    print("\nREGRESSION_DETECTED=true")
else:
    print("\nREGRESSION_DETECTED=false")

# ── Guardar baseline ──────────────────────────────────────────────────
if save_bl:
    bl_data = {
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "commit": commit,
        "brands": brand_state,
    }
    with open(bl_file, 'w') as f:
        json.dump(bl_data, f, indent=2, ensure_ascii=False)
    print(f"BASELINE_SAVED=true  commit={commit[:8]}")
PYEOF

COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo "unknown")"
PY_OUT="$(python3 "$TMP_PY" "$TMP_REFS" "$BASELINE" "$SAVE_BASELINE" "$COMMIT")"

# Imprimir todo excepto las líneas de control
echo "$PY_OUT" | grep -v -E '^(PASS_TOTAL|FAIL_TOTAL|REGRESSION_DETECTED|BASELINE_SAVED)='

# Procesar líneas de control
TOTAL_LINE="$(echo "$PY_OUT" | grep -E '^(PASS_TOTAL|FAIL_TOTAL)=' || echo 'FAIL_TOTAL=desconocido')"
if [[ "$TOTAL_LINE" == PASS_TOTAL* ]]; then
  pass "$(echo "$TOTAL_LINE" | cut -d= -f2-)"
else
  fail "$(echo "$TOTAL_LINE" | cut -d= -f2-)"
fi

REGRESSION="$(echo "$PY_OUT" | grep '^REGRESSION_DETECTED=' | cut -d= -f2 | tr -d '[:space:]')"

# ──────────────────────────────────────────────────────────────────────
# 3. Auto-revert si hay regresión
# ──────────────────────────────────────────────────────────────────────
if [[ "$REGRESSION" == "true" ]]; then
  FAIL=$((FAIL+1))
  echo -e "\n${BLD}3. Regresión detectada${NC}"

  if [[ "$REVERT_ON_FAIL" == "true" ]]; then
    BL_COMMIT="$(python3 -c "import json; print(json.load(open('$BASELINE')).get('commit',''))" 2>/dev/null || echo "")"

    if [[ -z "$BL_COMMIT" || "$BL_COMMIT" == "unknown" || "$BL_COMMIT" == "__COMMIT__" ]]; then
      fail "Baseline sin commit válido — revert manual necesario"
    elif [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
      fail "Falta CLOUDFLARE_API_TOKEN — no se puede desplegar revert"
      echo -e "  ${DIM}Exporta: export CLOUDFLARE_API_TOKEN=<tu_token>${NC}"
    else
      echo -e "  Restaurando index.js desde commit ${BL_COMMIT:0:8}..."
      if git -C "$REPO_ROOT" show "${BL_COMMIT}:creditek/workers/gemini-proxy/index.js" \
           > "$SCRIPT_DIR/index.js" 2>/dev/null; then
        cd "$SCRIPT_DIR"
        if CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler deploy \
             --config "$SCRIPT_DIR/wrangler.toml" 2>&1 | tail -6; then
          pass "Revert completado — Worker restaurado a commit ${BL_COMMIT:0:8}"
          echo -e "  ${YEL}⚠ index.js en disco fue sobrescrito con la versión del revert${NC}"
          echo -e "  ${YEL}  Haz 'git checkout -- index.js' para restaurar el estado del repo${NC}"
        else
          fail "Deploy del revert falló — revisar manualmente"
        fi
      else
        fail "No se pudo extraer index.js del commit $BL_COMMIT"
      fi
    fi
  else
    echo -e "  ${YEL}ℹ${NC} Ejecuta con ${BLD}--revert${NC} para revertir automáticamente"
  fi
fi

# ──────────────────────────────────────────────────────────────────────
# Baseline guardado
# ──────────────────────────────────────────────────────────────────────
BL_SAVED="$(echo "$PY_OUT" | grep '^BASELINE_SAVED=' | cut -d= -f2 | tr -d '[:space:]' || echo "")"
if [[ "$BL_SAVED" == true* ]]; then
  SHORT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  echo -e "\n  ${GRN}✓ Baseline guardado${NC} — commit $SHORT  •  $(date '+%Y-%m-%d %H:%M')"
  echo -e "  ${DIM}Archivo: $BASELINE${NC}"
fi

# ──────────────────────────────────────────────────────────────────────
# Resumen final
# ──────────────────────────────────────────────────────────────────────
echo -e "\n${BLD}══════════════════════════════════════════════════════${NC}"
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GRN}${BLD}  TODOS LOS TESTS PASARON  ✓ $PASS pasados${NC}"
else
  echo -e "${RED}${BLD}  TESTS FALLARON  ✓ $PASS  ✗ $FAIL${NC}"
fi
echo -e "${BLD}══════════════════════════════════════════════════════${NC}\n"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
