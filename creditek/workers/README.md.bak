# Creditek Gemini Proxy — Cloudflare Worker

Resuelve el error CORS que bloquea las llamadas a la Gemini Imagen API
desde el browser. El Worker actúa como intermediario sin costo
(plan gratuito de Cloudflare: 100 000 requests/día).

## Rutas disponibles

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/generate` | Proxy a Imagen `:predict` (modelos `imagen-X.0-*`) |
| `POST` | `/generate-content` | Proxy a Gemini `:generateContent` con `IMAGE` modality |
| `POST` | `/test` | Prueba todos los modelos y devuelve qué funciona |

---

## Despliegue paso a paso

### 1. Requisitos previos

```bash
# Node.js 18+ requerido
node --version

# Instalar Wrangler CLI
npm install -g wrangler
```

### 2. Autenticarse en Cloudflare

```bash
wrangler login
# Abre el browser — autoriza Wrangler en tu cuenta Cloudflare
```

### 3. Ir a la carpeta del Worker

```bash
cd creditek/workers
```

### 4. Configurar la API key como secret (recomendado)

```bash
wrangler secret put GEMINI_API_KEY
# Pega tu API key de Google AI Studio cuando se pida
```

> Si no configuras el secret, el agente puede enviar la key en el header
> `X-Gemini-Key` de cada petición (menos seguro pero funciona).

### 5. Desplegar

```bash
wrangler deploy
```

La URL del Worker aparece al final del output:
```
https://creditek-gemini-proxy.<tu-subdominio>.workers.dev
```

---

## Usar desde el agente (creditek-agente-redes.html)

En el agente, reemplaza las llamadas directas a Gemini por el proxy.
Ejemplo en `generarConGemini()`:

```js
// ANTES (bloqueado por CORS):
const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${key}`;
fetch(url, { body: JSON.stringify({ instances: [...], parameters: {...} }) });

// DESPUÉS (via proxy):
const PROXY_URL = 'https://creditek-gemini-proxy.<tu-subdominio>.workers.dev';
fetch(`${PROXY_URL}/generate`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Gemini-Key': key,          // solo si no usas el secret del Worker
  },
  body: JSON.stringify({
    prompt,
    negativePrompt,
    model:       'imagen-4.0-generate-preview-06-06',
    aspectRatio: '1:1',           // o '9:16' para Stories
    apiVersion:  'v1beta',
  }),
});
// La respuesta tiene el mismo formato que la API de Gemini:
// { predictions: [{ bytesBase64Encoded: "..." }] }
```

### Verificar qué modelos están disponibles

```bash
curl -X POST https://creditek-gemini-proxy.<tu-subdominio>.workers.dev/test \
  -H "Content-Type: application/json" \
  -H "X-Gemini-Key: AIzaSy..." \
  -d '{}' | jq '.results[] | select(.ok) | {model, ver, hasImage}'
```

---

## Seguridad

| Opción | Seguridad | Comodidad |
|--------|-----------|-----------|
| `GEMINI_API_KEY` como secret en Worker | Alta — key nunca sale del Worker | Requiere redesplegar para cambiar la key |
| `X-Gemini-Key` header en cada petición | Media — viaja cifrado (HTTPS) | El usuario controla su propia key |

Para producción se recomienda usar el secret del Worker y restringir
el `Access-Control-Allow-Origin` a tu dominio en lugar de `*`.

---

## Desarrollo local

```bash
wrangler dev
# Worker disponible en http://localhost:8787
```

## Logs en tiempo real

```bash
wrangler tail
```
