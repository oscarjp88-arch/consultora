/**
 * Creditek — Gemini / Vertex AI Image Generation Proxy
 *
 * Autenticación Vertex AI (WIF):
 *   Worker JWT (aud = WORKER_URL) → Google STS (token federado)
 *   → SA impersonation → Bearer token → Vertex AI
 *
 * El JWT del Worker se verifica via OIDC:
 *   Google STS fetcha {iss}/.well-known/openid-configuration → jwks_uri → JWKS
 *   y comprueba que aud ∈ allowed_audiences del provider WIF.
 *
 * Fallback: GEMINI_API_KEY → AI Studio (Imagen 3 / Gemini)
 *
 * POST /generate  { prompt, aspectRatio?, apiKey? }
 * GET  /health
 * GET  /.well-known/openid-configuration   ← requerido por WIF
 * GET  /.well-known/jwks.json              ← requerido por WIF
 *
 * Secrets (wrangler secret put):
 *   GCP_WIF_PRIVATE_KEY  — clave privada RSA del Worker (firma el JWT)
 *   GCP_WIF_PUBLIC_JWK   — JWK de la clave pública (JSON string)
 *   GEMINI_API_KEY       — API key AI Studio (fallback)
 *
 * Vars (wrangler.toml):
 *   GCP_WIF_AUDIENCE     — recurso completo del provider WIF en GCP
 *   GCP_PROJECT_ID       — creditek-imagen
 *   GCP_SA_EMAIL         — SA con roles/aiplatform.user
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// Debe coincidir EXACTAMENTE con "allowed-audiences" configurado en el provider WIF.
// El JWT se firma con aud = esta URL, y Google STS la valida contra esa lista.
const WORKER_URL = 'https://creditek-gemini-proxy.comercial-853.workers.dev';

const VERTEX_MODELS = [
  { id: 'imagen-4.0-generate-preview-06-06', label: 'Imagen 4' },
  { id: 'imagen-4.0-generate-preview-05-20', label: 'Imagen 4 (may)' },
  // Imagen 3 GA — disponible sin allowlist, sirve como fallback mientras se activa Imagen 4 preview
  { id: 'imagen-3.0-generate-001', label: 'Imagen 3 (Vertex)' },
  { id: 'imagen-3.0-fast-generate-001', label: 'Imagen 3 Fast (Vertex)' },
];

const IMAGEN_STUDIO_MODELS = [
  { id: 'imagen-3.0-generate-001', label: 'Imagen 3' },
  { id: 'imagen-3.0-fast-generate-001', label: 'Imagen 3 Fast' },
];

const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash-exp-image-generation', label: 'Gemini Flash Image Gen' },
  { id: 'gemini-2.0-flash-preview-image-generation', label: 'Gemini 2.0 Flash Image' },
];

// Token cache — persiste dentro del mismo isolate
let _saToken = null;
let _saTokenExpiry = 0;

// Codifica un objeto como base64url (JWT header/payload)
function b64urlJson(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Codifica bytes crudos como base64url (JWT signature)
function b64urlBytes(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function signJwt(privateKeyPem, payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'creditek-key-1' };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;

  const pem = privateKeyPem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
  const keyBytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${b64urlBytes(new Uint8Array(sigBytes))}`;
}

async function getVertexToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (_saToken && now < _saTokenExpiry - 60) return _saToken;

  // JWT firmado por el Worker.
  // iss = issuer URL configurado en el WIF provider.
  // aud = URL en la lista allowed-audiences del WIF provider.
  // Ambos son WORKER_URL en esta configuración.
  const jwt = await signJwt(env.GCP_WIF_PRIVATE_KEY, {
    iss: WORKER_URL,
    sub: 'creditek-worker',
    aud: WORKER_URL,
    iat: now,
    exp: now + 3600,
  });

  // Paso 1: Intercambiar JWT por token federado WIF en Google STS
  const stsRes = await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience: env.GCP_WIF_AUDIENCE,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token: jwt,
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    }),
  });

  const stsData = await stsRes.json();
  if (!stsData.access_token) {
    throw new Error(`WIF STS error (${stsRes.status}): ${JSON.stringify(stsData)}`);
  }

  // Paso 2: Impersonar el SA para obtener un Bearer con permisos Vertex AI
  const impRes = await fetch(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.GCP_SA_EMAIL}:generateAccessToken`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stsData.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/cloud-platform'],
        lifetime: '3600s',
      }),
    }
  );

  const impData = await impRes.json();
  if (!impData.accessToken) {
    throw new Error(`SA impersonation error (${impRes.status}): ${JSON.stringify(impData)}`);
  }

  _saToken = impData.accessToken;
  _saTokenExpiry = Math.floor(new Date(impData.expireTime).getTime() / 1000);
  return _saToken;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    const path = new URL(request.url).pathname;

    // OIDC discovery — Google STS lo consulta para encontrar la jwks_uri
    if (path === '/.well-known/openid-configuration') {
      return new Response(JSON.stringify({
        issuer: WORKER_URL,
        jwks_uri: `${WORKER_URL}/.well-known/jwks.json`,
      }), { headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    // JWKS — Google STS lo consulta para verificar la firma del JWT del Worker
    if (path === '/.well-known/jwks.json') {
      const keys = env.GCP_WIF_PUBLIC_JWK ? [JSON.parse(env.GCP_WIF_PUBLIC_JWK)] : [];
      return new Response(JSON.stringify({ keys }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

if (path === '/test-fetch') {
      const urls = [
        'https://exito.com',
        'https://falabella.com.co',
        'https://alkosto.com',
        'https://ktronix.com',
      ];
      const results = await Promise.all(urls.map(async url => {
        try {
          const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
          return { url, status: res.status, ok: res.ok };
        } catch (e) {
          return { url, status: null, error: e.message };
        }
      }));
      return ok({ results });
    }

    if (path === '/health') {
      return ok({
        ok: true,
        wif: !!env.GCP_WIF_PRIVATE_KEY,
        jwks: !!env.GCP_WIF_PUBLIC_JWK,
        wif_audience: env.GCP_WIF_AUDIENCE || null,
        jwt_audience: WORKER_URL,
      });
    }

    if (path !== '/generate') return err('Usa POST /generate', 404);
    if (request.method !== 'POST') return err('Solo POST', 405);

    let body;
    try { body = await request.json(); }
    catch { return err('JSON inválido', 400); }

    const { prompt, aspectRatio = '1:1', apiKey } = body;
    if (!prompt) return err('Campo "prompt" requerido', 400);

    // ── Vía 1: Vertex AI con WIF + SA impersonation (Imagen 4) ───────────────
    if (env.GCP_WIF_PRIVATE_KEY && env.GCP_WIF_AUDIENCE && env.GCP_SA_EMAIL) {
      try {
        const token = await getVertexToken(env);

        for (const model of VERTEX_MODELS) {
          const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}/locations/us-central1/publishers/google/models/${model.id}:predict`;
          let res;
          try {
            res = await fetch(url, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                instances: [{ prompt }],
                parameters: { sampleCount: 1, aspectRatio },
              }),
            });
          } catch (_) { continue; }

          if (res.status === 404) continue;
          if (res.status === 403) {
            const d = await res.json().catch(() => ({}));
            return err(`Vertex 403 (permisos SA) model:${model.id}: ${JSON.stringify(d)}`, 403);
          }
          if (res.status === 401) break;

          const data = await res.json().catch(() => ({}));
          if (!res.ok) return err(`Vertex error ${res.status}: ${JSON.stringify(data)} model:${model.id}`, 500);

          const b64 = data.predictions?.[0]?.bytesBase64Encoded;
          if (!b64) continue;

          return ok({ predictions: data.predictions, model: model.id, label: model.label });
        }
      } catch (_e) {
        return err(`WIF error: ${_e.message}`, 500);
      }
    }

    // ── Vía 2: AI Studio key fallback (Imagen 3 + Gemini) ────────────────────
    const studioKey = (env.GEMINI_API_KEY || apiKey || '').trim();
    if (!studioKey) {
      return err('Configura GCP_WIF_PRIVATE_KEY (Vertex AI) o provee apiKey de AI Studio', 401);
    }

    for (const model of IMAGEN_STUDIO_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:predict?key=${studioKey}`;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1, aspectRatio },
          }),
        });
      } catch (_) { continue; }

      if (res.status === 404 || res.status === 403) continue;
      if (res.status === 401) return err('API key de AI Studio inválida.', 401);

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return err(`Studio error ${res.status}: ${JSON.stringify(data)} model:${model.id}`, 500);

      const b64 = data.predictions?.[0]?.bytesBase64Encoded;
      if (!b64) continue;

      return ok({ predictions: data.predictions, model: model.id, label: model.label });
    }

    for (const model of GEMINI_MODELS) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${studioKey}`;
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
      } catch (_) { continue; }

      if (res.status === 404 || res.status === 403) continue;
      if (res.status === 401) return err('API key de AI Studio inválida.', 401);

      const data = await res.json().catch(() => ({}));
      if (!res.ok) return err(`Gemini error ${res.status}: ${JSON.stringify(data)} model:${model.id}`, 500);

      const parts = data.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
      if (!imagePart) continue;

      return ok({
        predictions: [{ bytesBase64Encoded: imagePart.inlineData.data, mimeType: imagePart.inlineData.mimeType }],
        model: model.id,
        label: model.label,
      });
    }

    return err('Ningún modelo disponible. Verifica WIF o GEMINI_API_KEY.', 503);
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
