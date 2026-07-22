# PDF Combiner — Cloudflare Worker

Combina imágenes (PNG/JPG) y PDFs sueltos en un solo PDF final, usando
[`pdf-lib`](https://pdf-lib.js.org/). Pieza 1 del plan de cierres del Portal
B2B — construido y probado de forma aislada, sin conectar todavía al Apps
Script (eso es la Pieza 2).

**Flujo:** `Apps Script / frontend → Worker (pdf-lib) → PDF final en base64`

---

## Endpoint

### `POST /combinar`

```json
{
  "titulo": "Cierre quincena 09-jul-2026",
  "archivos": [
    { "nombre": "foto1.jpg", "tipo": "imagen", "base64": "..." },
    { "nombre": "reporte.pdf", "tipo": "pdf", "base64": "..." }
  ]
}
```

Header requerido: `X-Worker-Secret: <WORKER_SHARED_SECRET>`

Respuesta:
```json
{ "pdfBase64": "...", "paginas": 2 }
```

`tipo` es opcional si se manda `mimeType` (`application/pdf`, `image/png`,
`image/jpeg`) o si `nombre` trae la extensión — como último recurso se
detecta por los magic bytes del archivo.

### `GET /health`

```json
{ "ok": true, "allowedOrigin": "https://oscarjp88-arch.github.io" }
```

---

## Seguridad

Mismo patrón que `creditek-gemini-proxy`, con un endurecimiento adicional:

| Configuración | Detalle |
|---|---|
| `X-Worker-Secret` | Secreto compartido, igual que gemini-proxy (fix v5, 09-jul-2026) |
| CORS | Restringido a `https://oscarjp88-arch.github.io` desde el día 1 (gemini-proxy nació con `*` abierto y se corrigió después) |

Si Oscar configura un dominio propio (CNAME) para GitHub Pages más adelante,
actualizar `ALLOWED_ORIGIN` en `index.js`.

---

## Despliegue

```bash
cd creditek/workers/pdf-combiner
npm install
wrangler secret put WORKER_SHARED_SECRET   # generar con: openssl rand -hex 24
wrangler deploy
```

## Desarrollo local

```bash
wrangler dev
# Worker disponible en http://localhost:8787
```

## Prueba aislada (sin Cloudflare, sin Apps Script)

```bash
npm run test:local
```

Genera una imagen PNG de prueba + un PDF ficticio de 1 página en memoria,
llama directo a `combinarPDF()` (la misma función que usa el fetch handler) y
valida que el resultado sea un PDF válido de 2 páginas.
