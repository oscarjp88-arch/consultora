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
  'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
};

// Debe coincidir EXACTAMENTE con "allowed-audiences" configurado en el provider WIF.
// El JWT se firma con aud = esta URL, y Google STS la valida contra esa lista.
const WORKER_URL = 'https://creditek-gemini-proxy.comercial-853.workers.dev';

// Fix v4 09-jul-2026: se eliminaron VERTEX_MODELS, IMAGEN_STUDIO_MODELS y
// GEMINI_MODELS (8 modelos Imagen 2/3/4 + Gemini 2.0 Flash Image) — todos
// apagados por Google el 30-jun-2026 o ya obsoletos (el propio código tenía
// un comentario "FIX v4o" reconociendo esto sin corregirlo). La cascada
// intentaba hasta 9 llamadas HTTP muertas antes de rendirse. Ver
// llamarGemini3Pro_() más abajo — único respaldo real que queda tras Vía 0.

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

// Fix v4 09-jul-2026: extraída del bloque inline `if (engine === 'gemini3pro')`
// para reutilizarla también como respaldo único de Vía 0 (ver más abajo), sin
// duplicar la llamada a Vertex AI. Devuelve directamente un Response (ok/err).
async function llamarGemini3Pro_(env, { prompt, imageUrl, imageBase64, imageMimeType, aspectRatio, extra = {}, via = null }) {
  if (!env.GCP_WIF_PRIVATE_KEY || !env.GCP_WIF_AUDIENCE) {
    return err('Falta GCP_WIF_PRIVATE_KEY para gemini3pro', 401);
  }
  const token = await getVertexToken(env);
  const g3url = `https://aiplatform.googleapis.com/v1/projects/${env.GCP_PROJECT_ID}/locations/global/publishers/google/models/gemini-3-pro-image:generateContent`;

  const parts = [];

  // Imagen de referencia del producto/logo (desde /brand-references o el logo
  // fijo de marca, vía HTML) — se descarga porque llega como URL remota.
  if (imageUrl) {
    try {
      const imgRes = await fetch(imageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(8_000),
        redirect: 'follow',
      });
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const mimeType = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg';
        parts.push({ inlineData: { mimeType, data: btoa(bin) } });
      }
    } catch { /* sin imagen de referencia — continuar solo con texto */ }
  }

  // FIX v16 12-jul-2026: imagen ACTUAL a editar (desde "Aplicar cambio" en el
  // frontend) — a diferencia de imageUrl, esta ya llega en base64 (currentSrc
  // es un data URL generado en memoria por el navegador, nunca tuvo una URL
  // pública que se pudiera fetch()ear). Se manda tal cual, sin descargar nada.
  if (imageBase64) {
    parts.push({ inlineData: { mimeType: imageMimeType || 'image/png', data: imageBase64 } });
  }

  parts.push({ text: prompt });

  const g3res = await fetch(g3url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        imageConfig: { aspectRatio },
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!g3res.ok) {
    const d = await g3res.json().catch(() => ({}));
    return err(d.error?.message || `gemini3pro error ${g3res.status}`, g3res.status);
  }

  const g3data = await g3res.json().catch(() => ({}));
  const imgPart = g3data.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!imgPart) return err('gemini3pro: sin imagen en respuesta', 502);

  return ok({
    predictions: [{ bytesBase64Encoded: imgPart.inlineData.data }],
    label: 'Gemini 3 Pro Image',
    ...extra,
  }, via);
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

    if (path === '/test-brands') {
      const TEST_URLS = [
        'https://www.tcl.com/mx/es/smartphones.html',
        'https://www.motorola.com/mx/smartphones',
        'https://www.oppo.com/mx/smartphones/',
        'https://www.realme.com/mx/smartphones/',
        'https://www.infinixmobility.com/mx',
        'https://www.honor.com/mx/phones/',
        'https://listado.mercadolibre.com.co/celulares-telefonos/celulares-smartphones/',
        'https://www.linio.com.co/c/celulares-y-smartphones',
        'https://www.ktronix.com/celulares',
        'https://www.falabella.com.co/falabella-co/category/cat40062/Celulares',
      ];
      const results = await Promise.all(TEST_URLS.map(async url => {
        const t0 = Date.now();
        try {
          const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
              'Accept-Language': 'es-CO,es;q=0.9',
            },
            signal: AbortSignal.timeout(8_000),
          });
          return {
            url,
            status: res.status,
            ok: res.status === 200 || res.status === 301 || res.status === 302,
            location: res.headers.get('location') || null,
            ms: Date.now() - t0,
          };
        } catch (e) {
          return { url, status: null, ok: false, error: e.message, ms: Date.now() - t0 };
        }
      }));
      return ok({ results });
    }

    if (path === '/brand-references') {
      // Modelos populares en Colombia 2025 (actualizar manualmente c/trimestre)
      // Samsung se obtiene dinámicamente desde su sitio web (JSON-LD con precios)
      // precioLista = precio de venta público oficial de cada fabricante.
      //   NO es el precio de cuota de Creditek — el agente HTML nunca lo usa en el prompt de imagen.
      const STATIC = {
        'Xiaomi CO': [
          { nombre: 'Redmi Note 15 Pro 5G', specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'200MP', bateria:'5110mAh', pantalla:'6.67"', procesador:'MediaTek Dimensity 7400 Ultra' }, precioLista: null },
          { nombre: 'Redmi Note 14 5G',     specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'108MP', bateria:'5110mAh', pantalla:'6.67"', procesador:'MediaTek Dimensity 7025 Ultra' }, precioLista: null },
          { nombre: 'Poco X7 Pro 5G',       specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'50MP',  bateria:'6000mAh', pantalla:'6.67"', procesador:'MediaTek Dimensity 7300 Ultra' }, precioLista: null },
          { nombre: 'Poco M6 Pro',          specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'64MP',  bateria:'5000mAh', pantalla:'6.67"' }, precioLista: null },
          { nombre: 'Redmi 14C',            specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP',  bateria:'5160mAh', pantalla:'6.88"', procesador:'MediaTek Helio G81 Ultra' }, precioLista: null },
          { nombre: 'Redmi 13C',            specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.74"' }, precioLista: null },
        ],
        'Motorola CO': [
          { nombre: 'Moto G85 5G',  specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'50MP', bateria:'5000mAh', pantalla:'6.67"', procesador:'Snapdragon 6s Gen 3' }, precioLista: null },
          { nombre: 'Moto G75 5G',  specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP', bateria:'5000mAh', pantalla:'6.78"', procesador:'Snapdragon 6 Gen 3' }, precioLista: null },
          { nombre: 'Moto G55 5G',  specs: { ram:'8GB RAM',  almacenamiento:'128GB', camara:'50MP', bateria:'5000mAh', pantalla:'6.49"', procesador:'MediaTek Dimensity 7025' }, precioLista: null },
          { nombre: 'Moto G35 5G',  specs: { ram:'8GB RAM',  almacenamiento:'128GB', camara:'50MP', bateria:'5000mAh', pantalla:'6.72"', procesador:'Unisoc T760' }, precioLista: null },
          { nombre: 'Moto E45',     specs: { ram:'4GB RAM',  almacenamiento:'128GB', camara:'48MP', bateria:'5000mAh', pantalla:'6.56"' }, precioLista: null },
          { nombre: 'Razr 50 5G',   specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP', bateria:'4200mAh', pantalla:'6.9"'  }, precioLista: null },
        ],
        'OPPO CO': [
          { nombre: 'OPPO Reno14 5G',    specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'50MP',  bateria:'5800mAh', pantalla:'6.76"' }, precioLista: null },
          { nombre: 'OPPO Reno14 F 5G',  specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.67"' }, precioLista: null },
          { nombre: 'OPPO Reno12 F 5G',  specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'108MP', bateria:'5000mAh', pantalla:'6.67"' }, precioLista: null },
          { nombre: 'OPPO A60',          specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.67"' }, precioLista: null },
          { nombre: 'OPPO Find N6',      specs: { ram:'16GB RAM', almacenamiento:'512GB', camara:'50MP',  bateria:'5600mAh', pantalla:'8.0"'  }, precioLista: null },
          { nombre: 'OPPO A6s',          specs: { ram:'6GB RAM',  almacenamiento:'128GB', camara:'13MP',  bateria:'5100mAh', pantalla:'6.67"' }, precioLista: null },
        ],
        'Realme CO': [
          { nombre: 'Realme GT 6',         specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'50MP',  bateria:'5500mAh', pantalla:'6.78"' }, precioLista: null },
          { nombre: 'Realme 12 Pro+',      specs: { ram:'12GB RAM', almacenamiento:'256GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.7"'  }, precioLista: null },
          { nombre: 'Realme C67',          specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'108MP', bateria:'5000mAh', pantalla:'6.72"' }, precioLista: null },
          { nombre: 'Realme Narzo 70x 5G', specs: { ram:'6GB RAM',  almacenamiento:'128GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.67"' }, precioLista: null },
          { nombre: 'Realme C55',          specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'64MP',  bateria:'5000mAh', pantalla:'6.72"' }, precioLista: null },
          { nombre: 'Realme 12 5G',        specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.72"' }, precioLista: null },
        ],
        'TCL CO': [
          { nombre: 'TCL 50 5G',    specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP', bateria:'5010mAh', pantalla:'6.6"'  }, precioLista: null },
          { nombre: 'TCL 40 XL 5G', specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'50MP', bateria:'5010mAh', pantalla:'6.78"' }, precioLista: null },
          { nombre: 'TCL 40 SE',    specs: { ram:'4GB RAM',  almacenamiento:'128GB', camara:'50MP', bateria:'5010mAh', pantalla:'6.75"' }, precioLista: null },
          { nombre: 'TCL 505',      specs: { ram:'4GB RAM',  almacenamiento:'128GB', camara:'50MP', bateria:'5000mAh', pantalla:'6.75"' }, precioLista: null },
          { nombre: 'TCL 30+',      specs: { ram:'4GB RAM',  almacenamiento:'128GB', camara:'50MP', bateria:'5000mAh', pantalla:'6.7"'  }, precioLista: null },
        ],
        'Honor CO': [
          { nombre: 'Honor X8b',        specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'108MP', bateria:'4500mAh', pantalla:'6.7"'  }, precioLista: null },
          { nombre: 'Honor 90 Lite',    specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'100MP', bateria:'4500mAh', pantalla:'6.7"'  }, precioLista: null },
          { nombre: 'Honor X7b',        specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'108MP', bateria:'6000mAh', pantalla:'6.8"'  }, precioLista: null },
          { nombre: 'Honor X6b',        specs: { ram:'6GB RAM',  almacenamiento:'128GB', camara:'50MP',  bateria:'5000mAh', pantalla:'6.56"' }, precioLista: null },
          { nombre: 'Honor Magic6 Lite',specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'100MP', bateria:'5000mAh', pantalla:'6.78"' }, precioLista: null },
        ],
        'Infinix CO': [
          { nombre: 'Infinix Note 40 Pro',  specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'108MP', bateria:'4600mAh', pantalla:'6.78"' }, precioLista: null },
          { nombre: 'Infinix Hot 40i',      specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'48MP',  bateria:'5000mAh', pantalla:'6.56"' }, precioLista: null },
          { nombre: 'Infinix Zero 30 5G',   specs: { ram:'8GB RAM',  almacenamiento:'256GB', camara:'108MP', bateria:'5000mAh', pantalla:'6.78"' }, precioLista: null },
          { nombre: 'Infinix Hot 30i',      specs: { ram:'4GB RAM',  almacenamiento:'128GB', camara:'13MP',  bateria:'5000mAh', pantalla:'6.56"' }, precioLista: null },
          { nombre: 'Infinix Smart 8',      specs: { ram:'4GB RAM',  almacenamiento:'64GB',  camara:'13MP',  bateria:'5000mAh', pantalla:'6.6"'  }, precioLista: null },
        ],
      };

      // Contexto estático de financieras aliadas — se usa para enriquecer prompts de imagen
      const FINANCIERAS_INFO = {
        'PayJoy CO': {
          tagline: 'Financia tu celular desde $0 de inicial',
          beneficios: 'Aprobación inmediata con cédula · Sin codeudor · Cuotas desde $29.900/mes',
          url: 'https://www.payjoy.com/co',
          color: '#00A651',
        },
        'Krediya': {
          tagline: 'Crédito digital rápido para tu celular',
          beneficios: 'Proceso 100% digital · Aprobación en minutos · Sin papelería',
          url: 'https://www.krediya.com.co',
          color: '#FF6B00',
        },
        'Addi CO': {
          tagline: 'Compra ahora, paga después — BNPL',
          beneficios: 'Divide en cuotas sin salir de la tienda · Sin intereses en plazos cortos · Aprobación instantánea',
          url: 'https://www.addi.com/co',
          color: '#A259FF',
        },
        'Alo Credit': {
          tagline: 'Crédito fácil para tu celular',
          beneficios: 'Crédito inmediato · Para todos los colombianos · Sin historial crediticio requerido',
          url: 'https://www.alocredit.co',
          color: '#00B4D8',
        },
      };

      // Fetch dinámico: Samsung desde samsung.com/co (JSON-LD); demás marcas desde sus sitios MX/CL
      const brands = [
        { marca: 'Samsung CO',  urls: ['https://www.samsung.com/co/smartphones/all-smartphones/'] },
        { marca: 'Xiaomi CO',   urls: [] },
        { marca: 'Motorola CO', urls: ['https://www.motorola.com/mx/smartphones', 'https://www.motorola.com/cl/smartphones'] },
        { marca: 'OPPO CO',     urls: ['https://www.oppo.com/mx/smartphones/'] },
        { marca: 'Realme CO',   urls: ['https://www.realme.com/cl/smartphones/', 'https://www.realme.com/pe/smartphones/'] },
        { marca: 'TCL CO',      urls: ['https://www.tcl.com/mx/es/smartphones', 'https://www.tcl.com/mx/es/smartphones.html'] },
        { marca: 'Honor CO',    urls: ['https://www.honor.com/mx/phones/'] },
        { marca: 'Infinix CO',  urls: ['https://www.infinixmobility.com/mx'] },
      ];

      // Lee hasta maxBytes del body para no cargar páginas enteras en memoria
      async function fetchHtml(url, maxBytes = 600_000) {
        const res = await fetch(url, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
            'Cache-Control': 'no-cache',
          },
          signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) return { html: '', status: res.status };
        const reader = res.body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
          if (total >= maxBytes) { reader.cancel(); break; }
        }
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.length; }
        return { html: new TextDecoder().decode(buf), status: res.status };
      }

      function stripTags(s) {
        return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }

      // Extrae specs de RAM/cámara/batería/pantalla de texto en español o inglés
      function parseSpecs(text) {
        const specs = {};
        // RAM — "8GB RAM" / "RAM: 8GB" / "8 GB de RAM"
        const ram = text.match(/(\d+)\s*GB\s+(?:de\s+)?RAM/i)
                 || text.match(/RAM[:\s]+(\d+)\s*GB/i);
        // Almacenamiento — español e inglés (storage / ROM / internal)
        const storage = text.match(/(\d+)\s*GB\s+(?:de\s+)?(?:almacenamiento|ROM|storage|memoria\s+interna|internal)/i)
                     || text.match(/(?:storage|almacenamiento|ROM)[:\s]+(\d+)\s*GB/i);
        // Cámara principal — con o sin la palabra cámara/camera
        const cam = text.match(/(\d+)\s*MP\s+(?:c[aá]mara|camera|principal|main|rear|trasera)/i)
                 || text.match(/(?:c[aá]mara|camera)[^.]{0,30}?(\d+)\s*MP/i)
                 || text.match(/(\d+)\s*MP/i);
        // Batería — mAh
        const bat = text.match(/(\d[\d.]*)\s*mAh/i);
        // Pantalla — pulgadas / inches / símbolo " ″
        const screen = text.match(/(\d+[.,]\d+)\s*(?:pulgadas|pulg\b|["″]|inch(?:es)?)/i)
                    || text.match(/(?:pantalla|display|screen)[:\s]+(\d+[.,]\d+)/i);
        // Procesador
        const chip = text.match(/(?:Snapdragon|Dimensity|Exynos|Helio[_ ]?[GP]?\d|MediaTek\s+\w+)\s*[\w\d+]*/i);
        if (ram)     specs.ram            = ram[1] + 'GB RAM';
        if (storage) specs.almacenamiento = storage[1] + 'GB';
        if (cam)     specs.camara         = cam[1] + 'MP';
        if (bat)     specs.bateria        = bat[1] + 'mAh';
        if (screen)  specs.pantalla       = screen[1].replace(',', '.') + '"';
        if (chip)    specs.procesador     = chip[0];
        return Object.keys(specs).length ? specs : null;
      }

      // Extrae precio en formato colombiano ($1.299.900)
      function parsePrice(text) {
        const m = text.match(/\$\s*([\d.,]{4,})/);
        return m ? '$' + m[1] : null;
      }

      // Palabras clave por marca para detectar modelos en títulos de Google Shopping / Amazon
      const BRAND_KEYWORDS = {
        'Xiaomi':   ['xiaomi', 'redmi', 'poco'],
        'Motorola': ['motorola', 'moto g', 'moto e', 'moto s', 'razr'],
        'Realme':   ['realme', 'narzo'],
        'TCL':      ['tcl'],
        'OPPO':     ['oppo', 'reno'],
        'Honor':    ['honor'],
        'Infinix':  ['infinix'],
      };

      // Google Shopping CO — fuente live para marcas sin web oficial accesible
      async function fetchGoogleShoppingModelos(marcaBase) {
        const q = encodeURIComponent(marcaBase + ' celular colombia');
        const url = `https://www.google.com.co/search?q=${q}&tbm=shop&hl=es&gl=co`;
        try {
          const { html, status } = await fetchHtml(url, 300_000);
          if (!html || status !== 200) return null;
          const seen = new Set();
          const modelos = [];
          const keywords = BRAND_KEYWORDS[marcaBase] || [marcaBase.toLowerCase()];
          const matches = (t) => keywords.some(kw => t.toLowerCase().includes(kw));
          for (const m of html.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi)) {
            const text = stripTags(m[1]).trim();
            if (!text || text.length > 120 || seen.has(text) || !matches(text)) continue;
            seen.add(text);
            modelos.push({ nombre: text, specs: parseSpecs(text), precioLista: parsePrice(text) });
          }
          for (const m of html.matchAll(/aria-label="([^"]{10,100})"/g)) {
            const text = m[1].trim();
            if (seen.has(text) || !matches(text)) continue;
            seen.add(text);
            modelos.push({ nombre: text, specs: parseSpecs(text), precioLista: null });
          }
          return modelos.length >= 2 ? modelos.slice(0, 10) : null;
        } catch { return null; }
      }

      // Amazon MX — fallback secundario para specs técnicas
      async function fetchAmazonModelos(marcaBase) {
        const q = encodeURIComponent(marcaBase + ' celular');
        const url = `https://www.amazon.com.mx/s?k=${q}&i=electronics`;
        try {
          const { html, status } = await fetchHtml(url, 300_000);
          if (!html || status !== 200) return null;
          const seen = new Set();
          const modelos = [];
          const brandLc = marcaBase.toLowerCase();
          for (const m of html.matchAll(/<span\b[^>]*class="[^"]*a-size-medium[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)) {
            const text = stripTags(m[1]).trim();
            if (!text || text.length < 8 || text.length > 150 || seen.has(text)) continue;
            if (!text.toLowerCase().includes(brandLc)) continue;
            seen.add(text);
            modelos.push({ nombre: text.slice(0, 100), specs: parseSpecs(text), precioLista: null });
          }
          return modelos.length >= 2 ? modelos.slice(0, 10) : null;
        } catch { return null; }
      }

      const GS_BRANDS = ['Xiaomi', 'Motorola', 'Realme', 'TCL', 'OPPO', 'Infinix', 'Honor'];

      async function extractModels({ marca, urls }) {
        const marcaBase = marca.replace(/\s+(CO|MX|CL|PE)$/, '');

        // Sin URLs propias: intentar Google Shopping antes de caer a static
        if (!urls.length) {
          if (GS_BRANDS.includes(marcaBase)) {
            const gsResult = await fetchGoogleShoppingModelos(marcaBase);
            if (gsResult?.length) return { marca, status: 200, url: 'google-shopping', modelos: gsResult.slice(0, 12), contexto: '' };
          }
          if (STATIC[marca]) return { marca, status: 200, url: 'static', modelos: STATIC[marca], contexto: '' };
        }

        let html = '', status = 0, usedUrl = '';
        for (const url of urls) {
          const result = await fetchHtml(url);
          if (result.html && result.status === 200) { html = result.html; status = result.status; usedUrl = url; break; }
          status = result.status;
        }
        try {
          if (!html) {
            if (GS_BRANDS.includes(marcaBase)) {
              const gsResult = await fetchGoogleShoppingModelos(marcaBase);
              if (gsResult?.length) return { marca, status: 200, url: 'google-shopping', modelos: gsResult.slice(0, 12), contexto: '' };
            }
            return { marca, modelos: STATIC[marca] || [], status, url: usedUrl };
          }

          const seen   = new Set();
          const modelos = [];

          // ── 1. JSON-LD structured data — fuente más confiable ──────────────
          for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
            try {
              const data  = JSON.parse(m[1]);
              const items = [data].flat();
              for (const node of items) {
                // ItemList con productos
                const products = node['@type'] === 'ItemList'
                  ? (node.itemListElement || []).map(e => e.item || e).filter(Boolean)
                  : node['@type'] === 'Product' ? [node] : [];
                for (const p of products) {
                  const nombre = (p.name || '').trim();
                  if (!nombre || seen.has(nombre) || nombre.length > 100) continue;
                  seen.add(nombre);
                  const desc  = [p.description || '', p.name || ''].join(' ');
                  // precioLista = PVP oficial; nunca usarlo en el prompt de imagen (el precio viene del formulario)
                  const precioLista = p.offers?.price
                    ? `$${Number(p.offers.price).toLocaleString('es-CO')}`
                    : parsePrice(desc);
                  // imagenRef = URL oficial del producto para pasarla a Gemini 3 Pro Image como referencia
                  const imagenRef = p.image
                    ? (Array.isArray(p.image) ? p.image[0] : p.image)
                    : null;
                  modelos.push({ nombre, specs: parseSpecs(desc), precioLista, imagenRef });
                }
              }
            } catch { /* JSON malformado — ignorar */ }
          }

          // ── 2. Meta og:title / description — al menos nombre de la página ──
          const ogTitle = (html.match(/property=["']og:title["'][^>]*content=["']([^"']{3,80})["']/i)
                       || html.match(/content=["']([^"']{3,80})["'][^>]*property=["']og:title["']/i))?.[1] || '';
          const metaDesc = (html.match(/name=["']description["'][^>]*content=["']([^"']{10,200})["']/i)
                        || html.match(/content=["']([^"']{10,200})["'][^>]*name=["']description["']/i))?.[1] || '';

          // ── 3. H2/H3 — nombres de modelos en páginas de listing ────────────
          for (const m of html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
            const text = stripTags(m[1]).trim();
            if (text.length < 6 || text.length > 120 || seen.has(text)) continue;
            // Detecta nombre de marca O specs inline (títulos MercadoLibre incluyen RAM/GB)
            const hasModel = /Galaxy|Redmi|Poco|Narzo|Moto\s*[A-Z]|Razr|Stylus|OPPO\s*[A-Z]|Reno\d|Find\s*[NX]|Realme\s*\d|GT\s*\d|Note\s*\d+\s*Pro|Samsung|Xiaomi|Motorola|TCL\s*\d|Honor\s*[X\d]|Magic\d|Infinix\s+(?:Hot|Note|Smart|Zero)|Infinix|Honor|TCL/i.test(text);
            const hasSpec  = /\d+\s*GB|\d+\s*MP|\d{4}\s*mAh/i.test(text);
            if (!hasModel && !hasSpec) continue;
            seen.add(text);
            modelos.push({ nombre: text, specs: parseSpecs(text), precioLista: parsePrice(text) });
          }

          // ── 4. Texto plano de la página para contexto general ──────────────
          const plainText = stripTags(
            html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<nav[\s\S]*?<\/nav>/gi, '')
              .replace(/<header[\s\S]*?<\/header>/gi, '')
              .replace(/<footer[\s\S]*?<\/footer>/gi, '')
          ).slice(0, 1000);

          // Si el live-fetch no extrajo modelos, intentar Google Shopping + Amazon antes de static
          let finalModelos = modelos.length ? modelos.slice(0, 12) : null;
          let gsUrl = null;   // 'google-shopping' | 'amazon-mx' | null

          if (!finalModelos && GS_BRANDS.includes(marcaBase)) {
            const gsResult = await fetchGoogleShoppingModelos(marcaBase);
            if (gsResult?.length) { finalModelos = gsResult; gsUrl = 'google-shopping'; }
            else {
              const amzResult = await fetchAmazonModelos(marcaBase);
              if (amzResult?.length) { finalModelos = amzResult; gsUrl = 'amazon-mx'; }
            }
          }

          if (!finalModelos) finalModelos = STATIC[marca] || [];

          // Preservar URL real cuando el sitio fue accesible (aunque los modelos vengan
          // de GS/STATIC). El HTML usa url+status+n_modelos para clasificar live/static.
          const returnUrl = gsUrl                          ? gsUrl
            : (usedUrl && status === 200 && finalModelos.length) ? usedUrl
            : finalModelos === STATIC[marca]              ? 'static'
            : usedUrl || 'static';

          return {
            marca,
            status: gsUrl ? 200 : status,
            url: returnUrl,
            modelos: finalModelos,
            contexto: [ogTitle, metaDesc].filter(Boolean).join(' | ').slice(0, 300) || plainText.slice(0, 300),
          };
        } catch (e) {
          return { marca, modelos: STATIC[marca] || [], contexto: '', status, url: usedUrl, error: e.message };
        }
      }

      const results = await Promise.all(brands.map(extractModels));
      return ok({ results, financieras: FINANCIERAS_INFO });
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

    // Fix v5 09-jul-2026 — hallazgo crítico: /generate estaba público sin
    // ninguna autenticación (CORS abierto a '*', sin chequeo de Authorization/
    // X-API-Key/origin). Esto permitió ~276.000 solicitudes en un día a costa
    // de la cuenta de Google de Creditek, probablemente un bot escaneando
    // subdominios *.workers.dev al azar. Este secreto compartido (idéntico al
    // configurado en el frontend, WORKER_SHARED_SECRET) bloquea ese tráfico.
    // No es seguridad perfecta (viaja en el JS fuente del sitio), pero corta
    // por completo a bots automáticos sin este header.
    if (!env.WORKER_SHARED_SECRET || request.headers.get('X-Worker-Secret') !== env.WORKER_SHARED_SECRET) {
      return err('No autorizado', 401);
    }

    let body;
    try { body = await request.json(); }
    catch { return err('JSON inválido', 400); }

    const { prompt, aspectRatio = '1:1', apiKey, engine, imageUrl, imageBase64, imageMimeType } = body;
    if (!prompt) return err('Campo "prompt" requerido', 400);
    let via0Skip = null; // razón por la que Vía 0 fue omitida (para debug)

    // ── Gemini 3 Pro Image — endpoint global, generateContent multimodal ─────
    // Fix v4 09-jul-2026: lógica extraída a llamarGemini3Pro_() (arriba), para
    // reutilizarla también como respaldo único de Vía 0 sin duplicar código.
    if (engine === 'gemini3pro') {
      return await llamarGemini3Pro_(env, { prompt, imageUrl, imageBase64, imageMimeType, aspectRatio });
    }

    // ── Vía 0: Nano Banana 2 — AI Studio gemini-3.1-flash-image-preview ────────
    const nbKey = (env.GEMINI_API_KEY || apiKey || '').trim();
    if (nbKey) {
      const nbUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${nbKey}`;
      try {
        const nbRes = await fetch(nbUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
          }),
          signal: AbortSignal.timeout(90_000),
        });

        if (nbRes.ok) {
          let nbData = {};
          try { nbData = await nbRes.json(); } catch { /* ignore */ }
          const nbParts = nbData.candidates?.[0]?.content?.parts || [];
          const nbImg = nbParts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
          if (nbImg) {
            return ok({
              predictions: [{ bytesBase64Encoded: nbImg.inlineData.data, mimeType: nbImg.inlineData.mimeType }],
              model: 'gemini-3.1-flash-image-preview',
              label: 'Nano Banana 2',
            }, '0: Nano Banana 2 (gemini-3.1-flash-image-preview)');
          }
          // ok pero sin inlineData — exponer partes para diagnóstico
          const partTypes = nbParts.map(p => p.inlineData ? `inlineData(${p.inlineData.mimeType})` : p.text ? 'text' : Object.keys(p).join(',')).join('|');
          return err(`Via0: HTTP 200 pero sin imagen. parts=[${partTypes || 'vacío'}] candidates=${nbData.candidates?.length ?? 0}`, 502);
        } else if (nbRes.status === 401) {
          return err('GEMINI_API_KEY inválida.', 401);
        } else {
          // 404/400/403 → caer a Vertex AI, pero exponer el motivo como header debug
          let errBody = '';
          try { errBody = await nbRes.text(); } catch { /* ignore */ }
          via0Skip = `Via0 skip: HTTP ${nbRes.status} — ${errBody.slice(0, 120)}`;
        }
      } catch (_) { /* timeout o red — continuar */ }
    }

    // ── Vía 1: Gemini 3 Pro Image — único respaldo tras Vía 0 ────────────────
    // Fix v4 09-jul-2026: reemplaza las Vías 1/2/3 viejas (8 modelos Imagen
    // 2/3/4 + Gemini 2.0 Flash Image, hasta 9 llamadas HTTP en cascada, todas
    // apagadas por Google el 30-jun-2026 o ya obsoletas). Si Vía 0 (Nano
    // Banana 2) falla, el único respaldo real es Gemini 3 Pro Image — mismo
    // motor que ya usa `engine === 'gemini3pro'` explícito, vía
    // llamarGemini3Pro_() (definida arriba, después de getVertexToken).
    return await llamarGemini3Pro_(env, {
      prompt, imageUrl, imageBase64, imageMimeType, aspectRatio,
      extra: via0Skip ? { via0Skip } : {},
      via: '1: Gemini 3 Pro Image (respaldo)',
    });
  },
};

function ok(data, via = null) {
  const body = via ? { ...data, via } : data;
  const headers = { ...CORS, 'Content-Type': 'application/json' };
  if (via) headers['X-Via'] = via;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

function err(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
