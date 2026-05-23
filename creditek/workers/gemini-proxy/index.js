/**
 * Creditek — Gemini Imagen Proxy
 *
 * Resuelve CORS: browser → Worker → Gemini API → browser
 *
 * POST /generate
 *   body: { prompt, negativePrompt?, aspectRatio?, apiKey }
 *   returns: { predictions: [{ bytesBase64Encoded }], model }
 *
 * POST /health
 *   returns: { ok: true }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MODELS = [
  { id: 'imagen-4.0-generate-preview-06-06', label: 'Gemini Imagen 4 (jun)' },
  { id: 'imagen-4.0-generate-preview-05-20', label: 'Gemini Imagen 4 (may)' },
];

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = new URL(request.url).pathname;

    if (path === '/health') {
      return ok({ ok: true });
    }

    if (path !== '/generate') {
      return err('Usa POST /generate', 404);
    }

    if (request.method !== 'POST') {
      return err('Solo POST', 405);
    }

    let body;
    try { body = await request.json(); }
    catch { return err('JSON inválido', 400); }

    const { prompt, negativePrompt = '', aspectRatio = '1:1', apiKey } = body;

    // API key: primero secret del Worker, luego body
    const key = env.GEMINI_API_KEY || apiKey;
    if (!key) return err('apiKey requerida en el body o configura el secret GEMINI_API_KEY', 401);
    if (!prompt) return err('Campo "prompt" requerido', 400);

    const instance = negativePrompt
      ? { prompt, negativePrompt }
      : { prompt };

    let lastError = 'Gemini Imagen no disponible. Verifica que Imagen API esté habilitada en tu proyecto.';

    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:predict?key=${key}`;

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instances: [instance],
            parameters: { sampleCount: 1, aspectRatio },
          }),
        });
      } catch (e) {
        return err(`Error de red al contactar Gemini: ${e.message}`, 502);
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401) {
          return err('API key de Gemini inválida. Verifica en Google AI Studio.', 401);
        }
        if ((res.status === 404 || res.status === 403) && model === MODELS[0]) {
          lastError = `Modelo ${model.id} no disponible (${res.status}), probando fallback...`;
          continue;
        }
        return err(data?.error?.message || `Error Gemini ${res.status}`, res.status);
      }

      const b64 = data.predictions?.[0]?.bytesBase64Encoded;
      if (!b64) {
        if (model === MODELS[0]) {
          lastError = 'Modelo principal sin imagen, probando fallback...';
          continue;
        }
        return err('Gemini respondió OK pero sin imagen. Verifica que Imagen API esté habilitada.', 502);
      }

      return ok({ predictions: data.predictions, model: model.id, label: model.label });
    }

    return err(lastError, 503);
  },
};

function ok(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
