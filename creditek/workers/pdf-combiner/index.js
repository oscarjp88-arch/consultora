/**
 * Creditek — PDF Combiner Worker
 *
 * Combina imágenes (PNG/JPG) y PDFs sueltos en un solo PDF final, usando
 * pdf-lib. Pieza 1 del plan de cierres del Portal B2B — construido aislado,
 * sin conectar todavía al Apps Script (eso es la Pieza 2).
 *
 * POST /combinar   { titulo, archivos: [{ nombre?, mimeType?, tipo?, base64 }] }
 *                  → { pdfBase64, paginas }
 * GET  /health
 *
 * Mismo patrón de seguridad que creditek-gemini-proxy:
 *   - Secreto compartido (X-Worker-Secret) — ver wrangler.toml.
 *   - CORS restringido al origen de GitHub Pages (no abierto con '*' como
 *     gemini-proxy — aquí se endurece desde el día 1, ver ALLOWED_ORIGIN).
 *
 * Secrets (wrangler secret put):
 *   WORKER_SHARED_SECRET — idéntico al configurado en el frontend/Apps Script
 *                           que llame a este Worker. Sin esto, /combinar
 *                           rechaza la petición con 401.
 */

import { PDFDocument } from 'pdf-lib';

// Origen exacto de GitHub Pages del repo "consultora" (sin CNAME configurado
// — ver `git remote -v` → oscarjp88-arch/consultora). Ajustar si Oscar
// configura un dominio propio (CNAME) más adelante.
const ALLOWED_ORIGIN = 'https://registro.crediteksas.com';

function corsHeaders(origin) {
  const allow = origin === ALLOWED_ORIGIN ? origin : 'null';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Secret',
    'Vary': 'Origin',
  };
}

function ok(data, cors) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

function err(message, status = 400, cors = {}) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}

// ── Base64 helpers (Workers no tiene Buffer — mismo patrón que gemini-proxy) ─
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000; // evitar "Maximum call stack" con String.fromCharCode en PDFs grandes
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

// ── Detección de tipo de archivo ──────────────────────────────────────────
// Orden de prioridad: tipo explícito > mimeType > extensión del nombre >
// magic bytes del contenido (fallback final, evita rechazar por metadata
// incompleta si el caller ya mandó el base64 correcto).
function detectarTipo(archivo, bytes) {
  const t = (archivo.tipo || '').toLowerCase();
  if (t === 'pdf' || t === 'imagen' || t === 'image') return t === 'image' ? 'imagen' : t;

  const mime = (archivo.mimeType || '').toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'imagen';

  const nombre = (archivo.nombre || '').toLowerCase();
  if (nombre.endsWith('.pdf')) return 'pdf';
  if (/\.(png|jpe?g)$/.test(nombre)) return 'imagen';

  // Magic bytes: "%PDF" al inicio del archivo
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  // PNG: 89 50 4E 47 ; JPEG: FF D8 FF
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'imagen';
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'imagen';

  return null; // desconocido — el caller debe reportar error claro
}

function esPng(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
}

// ── Combinar archivos en un solo PDF ──────────────────────────────────────
export async function combinarPDF({ titulo, archivos }) {
  if (!Array.isArray(archivos) || archivos.length === 0) {
    throw new Error('El campo "archivos" debe ser un arreglo no vacío');
  }

  const pdfDoc = await PDFDocument.create();
  if (titulo) pdfDoc.setTitle(titulo);

  for (let i = 0; i < archivos.length; i++) {
    const archivo = archivos[i];
    if (!archivo || !archivo.base64) {
      throw new Error(`archivos[${i}]: falta "base64"`);
    }
    const bytes = base64ToBytes(archivo.base64);
    const tipo = detectarTipo(archivo, bytes);

    if (tipo === 'pdf') {
      const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const copiedPages = await pdfDoc.copyPages(srcDoc, srcDoc.getPageIndices());
      copiedPages.forEach(p => pdfDoc.addPage(p));
    } else if (tipo === 'imagen') {
      const img = esPng(bytes) ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      const page = pdfDoc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      throw new Error(`archivos[${i}] (${archivo.nombre || 'sin nombre'}): tipo no reconocido — especifica "tipo" o "mimeType"`);
    }
  }

  const pdfBytes = await pdfDoc.save();
  return { pdfBytes, paginas: pdfDoc.getPageCount() };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const path = new URL(request.url).pathname;

    if (path === '/health') {
      return ok({ ok: true, allowedOrigin: ALLOWED_ORIGIN }, cors);
    }

    if (path !== '/combinar') return err('Usa POST /combinar', 404, cors);
    if (request.method !== 'POST') return err('Solo POST', 405, cors);

    // Mismo patrón de secreto compartido que gemini-proxy (fix v5, 09-jul-2026).
    if (!env.WORKER_SHARED_SECRET || request.headers.get('X-Worker-Secret') !== env.WORKER_SHARED_SECRET) {
      return err('No autorizado', 401, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return err('JSON inválido', 400, cors); }

    const { archivos, titulo } = body;

    try {
      const { pdfBytes, paginas } = await combinarPDF({ titulo, archivos });
      return ok({ pdfBase64: bytesToBase64(pdfBytes), paginas }, cors);
    } catch (e) {
      return err(e.message || 'Error combinando PDF', 500, cors);
    }
  },
};
