# Archivo — 03 jul 2026
Estos archivos se movieron aquí porque causaban confusión real: dos
wrangler.toml distintos declaraban el mismo `name = "creditek-gemini-proxy"`,
y wrangler a veces resolvía el equivocado sin el flag --config.
- gemini-proxy-viejo.wrangler.toml / .js: versión antigua del Worker de
  Gemini (195 líneas), reemplazada por creditek/workers/gemini-proxy/
  (833 líneas, con autenticación WIF). Nunca estuvo en producción real.
- creditek-cloudflare-pages-experimento.wrangler.jsonc: prueba de publicar
  el Hub/Panel de Respuestas como sitio estático en Cloudflare, del
  commit 064ebfd ("Panel Respuestas de Sofia", 19 jun 2026). Nunca se
  conectó a nada ni se volvió a tocar. El Worker real "creditek" en
  Cloudflare quedó con contenido viejo de despliegues accidentales.
