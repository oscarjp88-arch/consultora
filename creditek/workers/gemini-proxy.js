/**
 * Creditek — Gemini Imagen Proxy Worker
 *
 * Resuelve el bloqueo CORS que impide llamar a la API de Gemini Imagen
 * directamente desde el browser. El Worker actúa como intermediario:
 * browser → Worker (CORS libre) → Gemini API → browser
 *
 * Rutas:
 *   POST /generate         → Imagen :predict  (modelos imagen-X.0-generate-*)
 *   POST /generate-content → Gemini :generateContent con IMAGE modality
 *   POST /test             → Prueba todos los modelos y devuelve el primero que responde
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Gemini-Key',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Solo se aceptan POST' }, 405);
    }

    // API key: env secret tiene prioridad; si no, header X-Gemini-Key del browser
    const apiKey = env.GEMINI_API_KEY || request.headers.get('X-Gemini-Key');
    if (!apiKey) {
      return jsonResponse({
        error: 'API key requerida. Configura el secret GEMINI_API_KEY en el Worker ' +
               'o envía el header X-Gemini-Key en cada petición.'
      }, 401);
    }

    let body;
    try { body = await request.json(); }
    catch { return jsonResponse({ error: 'Body JSON inválido' }, 400); }

    const path = new URL(request.url).pathname;

    if (path === '/generate')         return handlePredict(body, apiKey);
    if (path === '/generate-content') return handleGenerateContent(body, apiKey);
    if (path === '/test')             return handleTest(body, apiKey);

    return jsonResponse({ error: `Ruta desconocida: ${path}. Usa /generate, /generate-content o /test` }, 404);
  }
};

// ── /generate ─────────────────────────────────────────────────────────────────
// Proxy a Imagen :predict (imagen-4.0-generate-*, imagegeneration@00X, etc.)
//
// Body esperado:
// {
//   prompt:          string  (requerido)
//   model?:          string  (default: imagen-4.0-generate-preview-06-06)
//   negativePrompt?: string
//   aspectRatio?:    "1:1" | "9:16" | "16:9"  (default: "1:1")
//   apiVersion?:     "v1beta" | "v1"            (default: "v1beta")
// }
async function handlePredict(body, apiKey) {
  const {
    prompt,
    model          = 'imagen-4.0-generate-preview-06-06',
    negativePrompt = '',
    aspectRatio    = '1:1',
    apiVersion     = 'v1beta',
  } = body;

  if (!prompt) return jsonResponse({ error: 'Campo "prompt" requerido' }, 400);

  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:predict?key=${apiKey}`;
  const instance = negativePrompt ? { prompt, negativePrompt } : { prompt };

  return proxyFetch(url, {
    instances: [instance],
    parameters: { sampleCount: 1, aspectRatio },
  });
}

// ── /generate-content ─────────────────────────────────────────────────────────
// Proxy a Gemini :generateContent con responseModalities: ["IMAGE"]
//
// Body esperado:
// {
//   prompt:      string  (requerido)
//   model?:      string  (default: gemini-2.0-flash-exp)
//   apiVersion?: string  (default: "v1beta")
// }
async function handleGenerateContent(body, apiKey) {
  const {
    prompt,
    model      = 'gemini-2.0-flash-exp',
    apiVersion = 'v1beta',
  } = body;

  if (!prompt) return jsonResponse({ error: 'Campo "prompt" requerido' }, 400);

  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:generateContent?key=${apiKey}`;

  return proxyFetch(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
  });
}

// ── /test ─────────────────────────────────────────────────────────────────────
// Prueba todos los modelos en orden y devuelve array de resultados.
// Útil para descubrir qué modelos están habilitados en el proyecto.
//
// Body esperado: { prompt?: string }
async function handleTest(body, apiKey) {
  const minPrompt = body?.prompt || 'A simple blue square. Minimal test image.';

  const models = [
    { id: 'imagen-4.0-generate-preview-06-06', ver: 'v1beta', type: 'predict' },
    { id: 'imagen-4.0-generate-preview-05-20', ver: 'v1beta', type: 'predict' },
    { id: 'imagen-4.0-generate-preview-04-18', ver: 'v1beta', type: 'predict' },
    { id: 'imagen-3.0-generate-002',           ver: 'v1beta', type: 'predict' },
    { id: 'imagegeneration@006',               ver: 'v1beta', type: 'predict' },
    { id: 'imagegeneration@005',               ver: 'v1beta', type: 'predict' },
    { id: 'imagen-4.0-generate-preview-06-06', ver: 'v1',     type: 'predict' },
    { id: 'imagen-4.0-generate-preview-05-20', ver: 'v1',     type: 'predict' },
    { id: 'gemini-2.0-flash-exp',              ver: 'v1beta', type: 'generateContent' },
  ];

  const results = await Promise.allSettled(models.map(async m => {
    const url = m.type === 'predict'
      ? `https://generativelanguage.googleapis.com/${m.ver}/models/${m.id}:predict?key=${apiKey}`
      : `https://generativelanguage.googleapis.com/${m.ver}/models/${m.id}:generateContent?key=${apiKey}`;

    const geminiBody = m.type === 'predict'
      ? { instances: [{ prompt: minPrompt }], parameters: { sampleCount: 1, aspectRatio: '1:1' } }
      : { contents: [{ parts: [{ text: minPrompt }] }], generationConfig: { responseModalities: ['IMAGE', 'TEXT'] } };

    const res  = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: AbortSignal.timeout(20000),
    });
    const data = await res.json().catch(() => ({}));

    let hasImage = false;
    if (res.ok) {
      hasImage = m.type === 'predict'
        ? !!data.predictions?.[0]?.bytesBase64Encoded
        : !!data.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
    }

    return {
      model:    m.id,
      ver:      m.ver,
      type:     m.type,
      status:   res.status,
      ok:       res.ok,
      hasImage,
      error:    res.ok ? null : (data?.error?.message || `HTTP ${res.status}`),
    };
  }));

  const output = results.map((r, i) => r.status === 'fulfilled'
    ? r.value
    : { ...models[i], ok: false, hasImage: false, error: r.reason?.message || 'fetch failed' }
  );

  return jsonResponse({ results: output });
}

// ── helpers ───────────────────────────────────────────────────────────────────
async function proxyFetch(url, geminiBody) {
  try {
    const res  = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
    });
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return jsonResponse({ error: `Error al contactar Gemini: ${e.message}` }, 502);
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
