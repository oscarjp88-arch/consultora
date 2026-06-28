# Diseño: Catálogo Enriquecido — Creditek B2B Portal

**Fecha:** 2026-06-21  
**Estado:** Aprobado, pendiente implementación

---

## Contexto

El portal B2B de Creditek (`creditek/portal/index.html`) ya está en producción con 11 tiendas. Carga productos y precios desde Google Apps Script (GAS). El proyecto agrega una capa de enriquecimiento (specs técnicas + imágenes) sin tocar la lógica de precios ni el flujo de pedidos.

**Fuente de verdad de precios:** Excel maestro en Drive (solo lectura).  
**Fuente de enriquecimiento:** Gemini API (specs) + URLs oficiales de fabricante (imágenes).  
**Producción:** JSON estático en GitHub Pages — cero dependencia de Drive en runtime.

---

## Arquitectura

```
Excel maestro (Drive, solo lectura)
        ↓
catalogo_creditek.py  ←── modo incremental: diff contra INDICE.xlsx en Drive
        ↓  Gemini API (specs + image URL por modelo)
Drive (_SPECS/*.json, _IMAGENES/*.jpg, INDICE.xlsx)
        ↓  fase sync al final de cada ejecución
creditek/data/catalogo.json  +  creditek/assets/imagenes/*.jpg
        ↓  git commit + push → GitHub Pages (CDN)
portal/index.html  ←── fetch paralelo: GAS (precios) + catalogo.json (enriquecimiento)
```

La clave de cruce entre enriquecimiento y catálogo es el **slug** del nombre de referencia (función `slug()` ya existente en el script).

---

## Pieza A — Gemini para specs + imagen URL

### Comportamiento por tipo de producto

| Tipo | Lógica |
|------|--------|
| Marca reconocida (Samsung, Honor, Motorola, Xiaomi, Infinix, Tecno, ZTE, Realme, OPPO, Vivo, POCO, Alcatel, Nokia, Huawei, TCL, iFFalcon, ITEL, JBL, Bose, Acer, HP, ASUS, Lenovo) | Llamada a Gemini: specs técnicas + URL imagen oficial del fabricante |
| Marca blanca/genérica (Corn, Krono, Fly, Hyundai, Net, XKIM) | Solo specs básicas descriptivas vía Gemini, sin imagen |
| Producto no identificable | Solo nombre y marca, sin specs ni imagen |

### Prompt a Gemini (por referencia)

```
Eres una base de datos de especificaciones técnicas de dispositivos electrónicos.
Para el producto: "{referencia}"

Responde ÚNICAMENTE con un objeto JSON válido con esta estructura exacta:
{
  "pantalla": "...",
  "ram_almacenamiento": "...",
  "camara": "...",
  "bateria": "...",
  "red": "...",
  "sistema": "...",
  "imagen_url": "URL directa a imagen oficial del fabricante, o null si no existe",
  "confianza": "alta|media|baja"
}

Reglas:
- Campos vacíos: string vacío "", nunca null (excepto imagen_url)
- imagen_url: URL directa a JPG/PNG del fabricante oficial (samsung.com, hihonor.com, motorola.com, etc.)
- Si no conoces el modelo exacto, usa confianza "baja" y rellena lo que puedas
- No expliques nada fuera del JSON
```

### Validación de imagen URL

Después de cada llamada a Gemini, si `imagen_url` no es null:
1. `HEAD` request a la URL (timeout 8s)
2. Si responde 200 con `Content-Type: image/*`: descargar y guardar
3. Si falla: marcar `tiene_imagen = False`, continuar sin error

### Rate limiting

- Gemini free tier: 15 RPM → espera 4 segundos entre llamadas
- Estimado: 212 refs × 4s = ~15 minutos (vs. 2 horas del scraping anterior)

---

## Pieza B — Modo incremental

### Detección automática de modo

```
inicio del script
  ├─ INDICE.xlsx existe en Drive?
  │     ├─ SÍ  → modo INCREMENTAL: cargar set de slugs procesados
  │     └─ NO  → modo MASIVO: procesar todo
```

No hay flags ni argumentos. Un solo comando siempre.

### Lógica de qué procesar

| Condición | Acción |
|-----------|--------|
| Slug no está en INDICE | Procesar completo (specs + imagen) |
| Slug en INDICE, `tiene_imagen=✓` | Saltar completamente |
| Slug en INDICE, `tiene_imagen=✗`, marca reconocida | Reintentar solo imagen (no re-llamar Gemini para specs) |
| Slug en INDICE, `tiene_imagen=✗`, marca genérica | Saltar (genéricas nunca tienen imagen) |

Al terminar, INDICE.xlsx se actualiza en Drive: nuevas filas se agregan, filas modificadas (imagen reintentada) se actualizan.

---

## Pieza C — Sync Drive → GitHub Pages

Fase final de cada ejecución (masiva o incremental):

1. Descargar todos los `.json` de `_SPECS/` en Drive
2. Descargar todos los `.jpg` de `_IMAGENES/` en Drive
3. Guardar en:
   - `creditek/data/specs/` (archivos individuales, para diagnóstico)
   - `creditek/assets/imagenes/` (imágenes JPG)
4. Generar `creditek/data/catalogo.json`:

```json
{
  "SAMSUNG_GALAXY_A15_4G": {
    "pantalla": "6.5\", PLS LCD",
    "ram_almacenamiento": "4GB RAM, 128GB",
    "camara": "50 MP, f/1.8",
    "bateria": "5000 mAh",
    "red": "4G",
    "sistema": "Android 14",
    "tiene_imagen": true,
    "confianza": "alta"
  }
}
```

5. `git add creditek/data/ creditek/assets/imagenes/`
6. `git commit -m "catálogo: sync {YYYY-MM-DD} ({N} refs, {img} con imagen)"`
7. `git push`

Si el push falla: error claro en terminal, archivos quedan en disco para push manual. El script no aborta — el push es el último paso.

---

## Pieza D — Portal: nuevo layout lineal

### Carga de datos

```javascript
// Los dos fetches corren en paralelo
const [catalogoGAS, enriquecimiento] = await Promise.allSettled([
  fetch(APPS_SCRIPT_URL + '?action=catalogo').then(r => r.json()),
  fetch('./data/catalogo.json').then(r => r.json())
]);
```

Si `catalogo.json` falla (red, primera vez antes del sync): el portal muestra los productos sin imagen ni specs — degradación graceful, idéntico al comportamiento actual.

### Layout por producto (nuevo)

```
┌─────────────────────────────────────────────────────────────────┐
│ [img 80×80] │ NOMBRE PRODUCTO · badge MARCA     │  $XXX.XXX    │
│  (o icono)  │ 📱 6.5" · 4/128GB · 50MP · 5000mAh│  [−] 1 [+]  │
│             │                                    │  [+ Agregar] │
└─────────────────────────────────────────────────────────────────┘
```

- **Imagen**: 80×80px, `object-fit: cover`, border-radius 8px. Fallback: placeholder con inicial de marca en turquesa.
- **Specs**: una sola línea con `·` como separador. Solo campos no-vacíos. Si no hay specs: solo muestra nombre + precio (igual que hoy).
- **Precio**: `Bebas Neue`, grande, prominente. Fuente de datos sin cambios (viene de GAS).
- **Carrito lateral, filtros, login, lógica de pedidos**: sin tocar.
- **Grid existente**: reemplazado por lista lineal (`flex-direction: column`).

### Función de cruce

```javascript
function getEnriquecimiento(nombreProducto) {
  if (!enriquecimientoData) return null;
  const slug = nombreProducto.toUpperCase()
    .replace(/[^\w\s.-]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 90);
  return enriquecimientoData[slug] || null;
}
```

---

## Archivos a crear/modificar

| Archivo | Acción |
|---------|--------|
| `catalogo_creditek.py` | Reescribir: reemplazar scraping GSMArena por Gemini API, agregar modo incremental, agregar fase sync |
| `creditek/data/catalogo.json` | Crear (generado por script) |
| `creditek/data/specs/*.json` | Crear (generado por script, uno por ref) |
| `creditek/assets/imagenes/*.jpg` | Crear (descargadas por script) |
| `creditek/portal/index.html` | Modificar: fetch paralelo + layout lineal |
| `.env` | Agregar `GEMINI_API_KEY` |
| `.gitignore` | Verificar que `.env` esté excluido |

---

## Invariantes

- El Excel maestro en Drive nunca se modifica.
- La lógica de precios en GAS/portal no se toca.
- El flujo de pedidos (carrito, tiendas, envío a GAS) no se toca.
- Si el script se vuelve a correr, no borra datos existentes (sobrescribe solo lo que procesa en esa ejecución).
- El portal funciona sin enriquecimiento — la capa es aditiva.
