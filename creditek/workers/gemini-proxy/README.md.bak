# Gemini Imagen Proxy — Cloudflare Worker

Resuelve el bloqueo CORS que impide llamar a Gemini Imagen API
directamente desde el browser o desde GitHub Pages.

**Flujo:** `browser → Worker (CORS libre) → Gemini API → browser`

**Costo:** gratuito en Cloudflare Workers (100 000 requests/día).

---

## Despliegue paso a paso

### 1. Crear cuenta en Cloudflare (gratis)

[cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) → crea cuenta con tu email.
No necesitas tarjeta de crédito.

### 2. Instalar Wrangler

```bash
npm install -g wrangler
```

> Requiere Node.js 18+. Verifica con `node --version`.

### 3. Autenticarte

```bash
wrangler login
```

Abre el browser, autoriza Wrangler en tu cuenta Cloudflare.

### 4. Ir a esta carpeta

```bash
cd creditek/workers/gemini-proxy
```

### 5. Configurar la API key (recomendado)

```bash
wrangler secret put GEMINI_API_KEY
```

Pega tu key de [Google AI Studio](https://aistudio.google.com/app/apikey) cuando se pida.

> Si omites este paso, el agente enviará la key en el body de cada petición (también funciona, pero la key viaja en cada request).

### 6. Desplegar

```bash
wrangler deploy
```

Al final del output aparece la URL:
```
https://creditek-gemini-proxy.<tu-subdominio>.workers.dev
```

**Copia esa URL** — la necesitas en el siguiente paso.

---

## Configurar en el agente

1. Abre `creditek-agente-redes.html` en el browser
2. Selecciona motor **✦ Gemini Imagen 4**
3. Clic en **Configurar key**
4. Ingresa tu API key de Google AI Studio
5. En el campo **URL del Worker proxy**, pega la URL del paso 6
6. Guarda

A partir de ese momento todas las generaciones con Gemini van por el proxy sin errores CORS.

---

## Verificar que funciona

```bash
curl -X POST https://creditek-gemini-proxy.TU-SUBDOMINIO.workers.dev/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"A blue square","apiKey":"AIzaSy..."}' \
  | jq '{model, hasImage: (.predictions[0].bytesBase64Encoded | length > 0)}'
```

O simplemente abre el agente y genera una imagen — si sale, el proxy está operativo.

```bash
# Health check
curl https://creditek-gemini-proxy.TU-SUBDOMINIO.workers.dev/health
# → {"ok":true}
```

---

## Desarrollo local

```bash
wrangler dev
# Worker disponible en http://localhost:8787
```

## Ver logs en tiempo real

```bash
wrangler tail
```

---

## Seguridad

| Configuración | Seguridad |
|---|---|
| `GEMINI_API_KEY` como secret del Worker | Alta — la key nunca sale del Worker |
| Key enviada desde el agente en el body | Media — viaja cifrada por HTTPS |

Para producción se recomienda usar el secret y cambiar `Access-Control-Allow-Origin: *`
por el dominio exacto del agente.
