/**
 * Creditek — Gemini Image Generation Proxy
 *
 * Resuelve CORS: browser → Worker → Gemini API → browser
 *
 * POST /generate
 *   body: { prompt, aspectRatio?, apiKey }
 *   returns: { predictions: [{ bytesBase64Encoded }], model, label }
 *
 * GET /health
 *   returns: { ok: true }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const MODELS = [
  { id: 'gemini-3.1-flash-image-preview',        label: 'Gemini 3.1 Flash Image' },
  { id: 'gemini-2.0-flash-exp-image-generation', label: 'Gemini Flash Image Gen' },
  { id: 'gemini-2.0-flash-exp',                  label: 'Gemini Flash Exp' },
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

    const { prompt, apiKey } = body;

    const key = env.GEMINI_API_KEY || apiKey;
    if (!key) return err('apiKey requerida en el body o configura el secret GEMINI_API_KEY', 401);
    if (!prompt) return err('Campo "prompt" requerido', 400);

    for (const model of MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${key}`;

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
          }),
        });
      } catch (e) {
        return err(`Error de red al contactar Gemini: ${e.message}`, 502);
      }

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          return err('API key de Gemini inválida o sin permisos. Verifica en Google AI Studio.', 401);
        }
        if (res.status === 404 && model !== MODELS[MODELS.length - 1]) continue;
        return err(data?.error?.message || `Error Gemini ${res.status}`, res.status);
      }

      const parts = data.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));

      if (!imagePart) {
        if (model !== MODELS[MODELS.length - 1]) continue;
        return err('Ningún modelo generó imagen. Verifica acceso a image generation en AI Studio.', 502);
      }

      return ok({
        predictions: [{ bytesBase64Encoded: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType }],
        model: model.id,
        label: model.label,
      });
    }
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
