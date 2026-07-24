/**
 * creditek-clientes — Worker de registro de clientes + OTP (Entregable 1)
 * SPEC_ClientesEntregable1_v1_15jul2026.md
 *
 * Separado por completo de creditek-bot (Sofía). No tocar ese Worker desde aquí.
 * Proyecto Supabase: creditek-erp (jfkmiyvcdfbsbwchyvol) — distinto del de Sofía.
 */

import { resolveRegistrationContext } from './registro-context';
import {
  isSecureOtpSendRequest,
  isSecureOtpVerifyRequest,
  sendSecureOtp,
  verifySecureOtp,
  type SecureOtpEnv,
} from './registro-otp';
import {
  isSecureRegistrationRequest,
  submitSecureRegistration,
  type SecureRegistrationEnv,
} from './registro-submit';
import {
  uploadSecureDocument,
  type SecureDocumentsEnv,
} from './registro-documents';

interface Env extends SecureOtpEnv, SecureRegistrationEnv, SecureDocumentsEnv {
  WHATSAPP_TOKEN: string;
  PHONE_NUMBER_ID: string;
  TURNSTILE_SITE_KEY: string;
  ALLOWED_ORIGIN: string;
  ALLOW_LEGACY_REGISTRATION_LINKS: string;
}

const SUPABASE_URL = 'https://jfkmiyvcdfbsbwchyvol.supabase.co';

// FIX pre-requisito de Oscar (spec, sección "Pre-requisitos"): plantilla de
// WhatsApp categoría "Authentication" creada en Meta Business Manager con este
// nombre exacto. Mientras esa plantilla no exista y esté aprobada, /api/otp/enviar
// devolverá error 500 al llamar a Graph API — es esperado, no es un bug de este código.
const OTP_TEMPLATE_NAME = 'codigo_verificacion_creditek';
// TODO Oscar: confirmar el código de idioma real con el que quedó aprobada la
// plantilla en Meta (es_CO / es / es_ES). Se deja es_CO como valor más probable
// para Colombia, pero si Meta la aprobó con otro código, este envío fallará con
// "template not found" hasta que se ajuste este valor.
const OTP_TEMPLATE_LANG = 'es_CO';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  });
  const requestOrigin = request.headers.get('Origin');
  if (
    requestOrigin &&
    env.ALLOWED_ORIGIN &&
    requestOrigin === env.ALLOWED_ORIGIN
  ) {
    headers.set('Access-Control-Allow-Origin', requestOrigin);
  }
  return headers;
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request, env)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sbHeaders(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function celularValido(v: unknown): v is string {
  return typeof v === 'string' && /^3\d{9}$/.test(v);
}
function cedulaValida(v: unknown): v is string {
  return typeof v === 'string' && /^\d{6,12}$/.test(v);
}
function codigoValido(v: unknown): v is string {
  return typeof v === 'string' && /^\d{6}$/.test(v);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    const url = new URL(request.url);
    const respond = (response: Response): Response =>
      withCors(response, request, env);
    try {
      if (url.pathname === '/api/registro/contexto' && request.method === 'GET') {
        return respond(await handleRegistroContexto(url, env));
      }
      if (url.pathname === '/api/registro/config' && request.method === 'GET') {
        return respond(json({
          turnstile_site_key: env.TURNSTILE_SITE_KEY ?? '',
        }));
      }
      if (url.pathname === '/api/origenes' && request.method === 'GET') {
        return respond(await handleOrigenes(env));
      }
      if (url.pathname === '/api/otp/enviar' && request.method === 'POST') {
        return respond(await handleOtpEnviarRoute(request, env));
      }
      if (url.pathname === '/api/otp/verificar' && request.method === 'POST') {
        return respond(await handleOtpVerificarRoute(request, env));
      }
      if (url.pathname === '/api/registro' && request.method === 'POST') {
        return respond(await handleRegistroRoute(request, env));
      }
      if (url.pathname === '/api/documentos' && request.method === 'POST') {
        return respond(await handleDocumentosRoute(request, env));
      }
      if (url.pathname === '/api/subir-cedula' && request.method === 'POST') {
        return respond(await handleSubirCedula(request, env));
      }
      return respond(json({ ok: false, error: 'Ruta no encontrada' }, 404));
    } catch (e) {
      console.error('[creditek-clientes] Error no controlado:', e);
      return respond(json({ ok: false, error: 'Error interno' }, 500));
    }
  },

  // FEATURE 22-jul-2026 · Reportes diarios por WhatsApp.
  // Ver bloque grande al final del archivo para toda la lógica.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(ejecutarReportesDiarios(env).catch((e) => {
      console.error('[REPORTES-DIARIOS] excepción no atrapada:', e);
    }));
  },
};

// ─── GET /api/registro/contexto ─────────────────────────────────────────
async function handleRegistroContexto(url: URL, env: Env): Promise<Response> {
  try {
    const context = await resolveRegistrationContext(
      url.searchParams.get('t') ?? '',
      env,
    );
    return json({ ok: true, contexto: context });
  } catch (contextError) {
    const code =
      contextError instanceof Error ? contextError.message : '';
    if (
      code === 'enlace_invalido' ||
      code === 'origen_invalido' ||
      code === 'captador_invalido'
    ) {
      return json(
        { ok: false, error: 'Enlace inválido o vencido' },
        404,
      );
    }

    console.error('[REGISTRO-CONTEXTO] Servicio no disponible');
    return json(
      { ok: false, error: 'No se pudo cargar el enlace de registro' },
      503,
    );
  }
}

async function requestJson(request: Request): Promise<unknown> {
  return request.clone().json().catch(() => null);
}

async function handleOtpEnviarRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await requestJson(request);
  if (isSecureOtpSendRequest(body)) {
    const secureResult = await sendSecureOtp(
      body,
      request.headers.get('CF-Connecting-IP'),
      env,
      {
        fetcher: fetch,
        sendOtp: (celular, codigo) =>
          enviarPlantillaOtp(celular, codigo, env),
      },
    );
    return json(secureResult.body, secureResult.status);
  }

  if (env.ALLOW_LEGACY_REGISTRATION_LINKS === 'true') {
    return handleOtpEnviar(request, env);
  }
  return json({ ok: false, error: 'Flujo de registro legado deshabilitado' }, 410);
}

async function handleOtpVerificarRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await requestJson(request);
  if (isSecureOtpVerifyRequest(body)) {
    const secureResult = await verifySecureOtp(body, env, {
      fetcher: fetch,
    });
    return json(secureResult.body, secureResult.status);
  }

  if (env.ALLOW_LEGACY_REGISTRATION_LINKS === 'true') {
    return handleOtpVerificar(request, env);
  }
  return json({ ok: false, error: 'Flujo de registro legado deshabilitado' }, 410);
}

async function handleRegistroRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const body = await requestJson(request);
  if (isSecureRegistrationRequest(body)) {
    const secureResult = await submitSecureRegistration(body, env, { fetcher: fetch });
    return json(secureResult.body, secureResult.status);
  }

  if (env.ALLOW_LEGACY_REGISTRATION_LINKS === 'true') {
    return handleRegistro(request, env);
  }
  return json({ ok: false, error: 'Flujo de registro legado deshabilitado' }, 410);
}

async function handleDocumentosRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  const secureResult = await uploadSecureDocument(await requestJson(request), env, {
    fetcher: fetch,
  });
  return json(secureResult.body, secureResult.status);
}

// ─── GET /api/origenes ──────────────────────────────────────────────────
// No está en la lista original de endpoints del documento (que solo pedía
// otp/enviar, otp/verificar, registro, subir-cedula) — se agregó porque la
// Pieza 2 exige mostrar un selector de tiendas/aliados cuando el ?origen= de
// la URL falta o no existe, y esa lista no puede vivir hardcodeada en el HTML
// sin quedar desactualizada cada vez que Oscar suma un aliado nuevo. Es de
// solo lectura, sin escritura ni lógica de negocio — no altera el alcance
// funcional del entregable.
async function handleOrigenes(env: Env): Promise<Response> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/origenes?activo=eq.true&select=codigo,nombre,tipo&order=codigo`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) {
    console.error('[ORIGENES] Error:', await r.text());
    return json({ ok: false, error: 'No se pudieron cargar los orígenes' }, 500);
  }
  const data = await r.json();
  return json({ ok: true, origenes: data });
}

// ─── POST /api/otp/enviar ───────────────────────────────────────────────
async function handleOtpEnviar(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  const celular = body?.celular;
  if (!celularValido(celular)) return json({ ok: false, error: 'Celular inválido' }, 400);

  // Rate limit: máximo 3 envíos por celular por hora
  const haceUnaHora = new Date(Date.now() - 3600_000).toISOString();
  const rCount = await fetch(
    `${SUPABASE_URL}/rest/v1/otp_codigos?celular=eq.${encodeURIComponent(celular)}&created_at=gte.${haceUnaHora}&select=id`,
    { headers: sbHeaders(env, { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' }) }
  );
  const total = parseInt(rCount.headers.get('Content-Range')?.split('/')[1] ?? '0', 10);
  if (total >= 3) {
    return json({ ok: false, error: 'Ya se enviaron 3 códigos a este número en la última hora. Intenta más tarde.' }, 429);
  }

  const codigo = String(Math.floor(100000 + Math.random() * 900000));
  const expiraAt = new Date(Date.now() + 5 * 60_000).toISOString();

  const rInsert = await fetch(`${SUPABASE_URL}/rest/v1/otp_codigos`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ celular, codigo, expira_at: expiraAt }),
  });
  if (!rInsert.ok) {
    console.error('[OTP-ENVIAR] Error guardando código:', await rInsert.text());
    return json({ ok: false, error: 'No se pudo generar el código' }, 500);
  }

  const enviado = await enviarPlantillaOtp(celular, codigo, env);
  if (!enviado) return json({ ok: false, error: 'No se pudo enviar el código por WhatsApp' }, 500);

  return json({ ok: true });
}

async function enviarPlantillaOtp(celular: string, codigo: string, env: Env): Promise<boolean> {
  // Formato Graph API para plantillas de categoría Authentication con botón
  // "copy code": el código va dos veces — una en el body, otra en el botón
  // (sub_type "url", index 0). Verificado contra la documentación vigente de
  // Meta/360dialog para WhatsApp Cloud API (jul-2026), no de memoria.
  const res = await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: `57${celular}`,
      type: 'template',
      template: {
        name: OTP_TEMPLATE_NAME,
        language: { code: OTP_TEMPLATE_LANG },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: codigo }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: codigo }] },
        ],
      },
    }),
  });
  if (!res.ok) {
    console.error('[OTP-WA] Error enviando plantilla:', await res.text());
    return false;
  }
  return true;
}

// ─── POST /api/otp/verificar ────────────────────────────────────────────
async function handleOtpVerificar(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  const celular = body?.celular;
  const codigo = body?.codigo;
  if (!celularValido(celular) || !codigoValido(codigo)) {
    return json({ ok: false, error: 'Datos inválidos' }, 400);
  }

  const ahora = new Date().toISOString();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/otp_codigos?celular=eq.${encodeURIComponent(celular)}&verificado=eq.false&expira_at=gte.${ahora}&order=created_at.desc&limit=1`,
    { headers: sbHeaders(env) }
  );
  const filas = ((await r.json().catch(() => [])) as any[]) || [];
  const fila = filas[0];
  if (!fila) return json({ ok: false, error: 'Código vencido o no encontrado. Solicita uno nuevo.' }, 400);
  if ((fila.intentos ?? 0) >= 3) {
    return json({ ok: false, error: 'Demasiados intentos con este código. Solicita uno nuevo.' }, 429);
  }

  if (fila.codigo !== codigo) {
    await fetch(`${SUPABASE_URL}/rest/v1/otp_codigos?id=eq.${fila.id}`, {
      method: 'PATCH',
      headers: sbHeaders(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify({ intentos: (fila.intentos ?? 0) + 1 }),
    });
    return json({ ok: false, error: 'Código incorrecto' }, 400);
  }

  await fetch(`${SUPABASE_URL}/rest/v1/otp_codigos?id=eq.${fila.id}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ verificado: true }),
  });
  return json({ ok: true });
}

// ─── POST /api/registro ─────────────────────────────────────────────────
async function handleRegistro(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  if (!body) return json({ ok: false, error: 'JSON inválido' }, 400);

  const {
    cedula, nombre_completo, celular, email, ciudad, direccion,
    origen_codigo, vendedor_nombre, producto_interes, financiera,
    referencias, autorizacion_datos, autorizacion_comercial, autorizacion_version, otp_ok,
  } = body;

  if (!cedulaValida(cedula)) return json({ ok: false, error: 'Cédula inválida (6 a 12 dígitos)' }, 400);
  if (!celularValido(celular)) return json({ ok: false, error: 'Celular inválido (formato 3XXXXXXXXX)' }, 400);
  if (!nombre_completo || String(nombre_completo).trim().length < 3) return json({ ok: false, error: 'Nombre completo requerido' }, 400);
  if (!ciudad || String(ciudad).trim().length < 2) return json({ ok: false, error: 'Ciudad requerida' }, 400);
  if (!vendedor_nombre || String(vendedor_nombre).trim().length < 2) return json({ ok: false, error: 'Vendedor requerido' }, 400);
  if (!origen_codigo) return json({ ok: false, error: 'Origen requerido' }, 400);
  if (autorizacion_datos !== true) return json({ ok: false, error: 'La autorización de datos es obligatoria' }, 400);
  if (!otp_ok) return json({ ok: false, error: 'Celular no verificado' }, 400);

  // No confiar solo en el flag otp_ok que manda el cliente — confirmar
  // server-side que ese celular realmente tiene una verificación reciente.
  const rOtp = await fetch(
    `${SUPABASE_URL}/rest/v1/otp_codigos?celular=eq.${encodeURIComponent(celular)}&verificado=eq.true&order=created_at.desc&limit=1`,
    { headers: sbHeaders(env) }
  );
  const otpFilas = ((await rOtp.json().catch(() => [])) as any[]) || [];
  const otpFila = otpFilas[0];
  if (!otpFila) return json({ ok: false, error: 'Celular no verificado' }, 400);
  const verificadoHaceMs = Date.now() - new Date(otpFila.created_at).getTime();
  if (verificadoHaceMs > 30 * 60_000) {
    return json({ ok: false, error: 'La verificación del celular venció, vuelve a verificar el código' }, 400);
  }

  // UPSERT por cédula: si ya existe, actualiza contacto y NO duplica.
  const clientePayload: Record<string, any> = {
    cedula,
    nombre_completo: String(nombre_completo).trim(),
    celular,
    celular_verificado: true,
    ciudad: String(ciudad).trim(),
    origen_codigo,
    fuente: 'formulario',
    autorizacion_datos: true,
    autorizacion_comercial: !!autorizacion_comercial,
    autorizacion_timestamp: new Date().toISOString(),
    autorizacion_version: autorizacion_version || null,
    updated_at: new Date().toISOString(),
  };
  if (email) clientePayload.email = email;
  if (direccion) clientePayload.direccion = direccion;

  const rUpsert = await fetch(`${SUPABASE_URL}/rest/v1/clientes?on_conflict=cedula`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(clientePayload),
  });
  if (!rUpsert.ok) {
    console.error('[REGISTRO] Error upsert cliente:', await rUpsert.text());
    return json({ ok: false, error: 'No se pudo guardar el cliente' }, 500);
  }
  const clienteRows = (await rUpsert.json()) as any[];
  const cliente = clienteRows[0];
  if (!cliente) return json({ ok: false, error: 'No se pudo guardar el cliente' }, 500);

  // Referencias (hasta 2, se insertan nuevas en cada registro — el documento
  // no pide deduplicarlas, solo el cliente se deduplica por cédula)
  const refsPayload = (Array.isArray(referencias) ? referencias : [])
    .slice(0, 2)
    .filter((r: any) => r && r.nombre && r.telefono)
    .map((r: any) => ({
      cliente_id: cliente.id,
      nombre: String(r.nombre).trim(),
      telefono: String(r.telefono).trim(),
      parentesco: r.parentesco || null,
    }));
  if (refsPayload.length) {
    const rRefs = await fetch(`${SUPABASE_URL}/rest/v1/referencias`, {
      method: 'POST',
      headers: sbHeaders(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify(refsPayload),
    });
    if (!rRefs.ok) console.error('[REGISTRO] Error guardando referencias:', await rRefs.text());
  }

  // Solicitud (siempre nueva — cada registro es un intento de crédito)
  const solicitudPayload = {
    cliente_id: cliente.id,
    origen_codigo,
    vendedor_nombre: String(vendedor_nombre).trim(),
    producto_interes: producto_interes ? String(producto_interes).trim() : null,
    financiera: financiera || null,
    estado_validacion: 'pendiente',
  };
  const rSol = await fetch(`${SUPABASE_URL}/rest/v1/solicitudes`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=representation' }),
    body: JSON.stringify(solicitudPayload),
  });
  if (!rSol.ok) {
    console.error('[REGISTRO] Error creando solicitud:', await rSol.text());
    return json({ ok: false, error: 'No se pudo crear la solicitud' }, 500);
  }
  const solRows = (await rSol.json()) as any[];
  const solicitud = solRows[0];

  // Audit log — best-effort, no bloquea la respuesta si falla
  fetch(`${SUPABASE_URL}/rest/v1/audit_log`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({
      usuario: String(vendedor_nombre).trim(),
      accion: 'registro_formulario',
      tabla: 'solicitudes',
      registro_id: solicitud?.id ?? null,
      detalle: { origen_codigo, cedula },
    }),
  }).catch((e) => console.error('[REGISTRO] Error audit_log (no bloqueante):', e));

  return json({ ok: true, solicitud_id: solicitud?.id });
}

// ─── POST /api/subir-cedula ──────────────────────────────────────────────
// AJUSTES_Registro_v2, Cambio 3: ahora recibe 3 tipos de foto por cliente
// (frente / reverso / selfie), cada una a su propia columna. La columna vieja
// foto_cedula_path queda como legado — no se escribe más desde aquí.
const COLUMNA_POR_TIPO: Record<string, string> = {
  frente: 'foto_cedula_frente_path',
  reverso: 'foto_cedula_reverso_path',
  selfie: 'selfie_cedula_path',
};

async function handleSubirCedula(request: Request, env: Env): Promise<Response> {
  if (env.ALLOW_LEGACY_REGISTRATION_LINKS !== 'true') {
    return json({ ok: false, error: 'Flujo de registro legado deshabilitado' }, 410);
  }
  const body = (await request.json().catch(() => null)) as any;
  const cedula = body?.cedula;
  const tipo = body?.tipo;
  const fotoBase64 = body?.foto_base64;
  const mime = body?.mime || 'image/jpeg';

  const columna = COLUMNA_POR_TIPO[tipo];
  if (!cedulaValida(cedula) || !columna || typeof fotoBase64 !== 'string' || !fotoBase64) {
    return json({ ok: false, error: 'Datos inválidos (tipo debe ser frente, reverso o selfie)' }, 400);
  }

  const ext = mime.includes('png') ? 'png' : 'jpg';
  const path = `${cedula}_${tipo}_${Date.now()}.${ext}`;

  let binario: Uint8Array;
  try {
    binario = base64ToUint8Array(fotoBase64);
  } catch {
    return json({ ok: false, error: 'Imagen inválida' }, 400);
  }

  const rUpload = await fetch(`${SUPABASE_URL}/storage/v1/object/cedulas/${path}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'Content-Type': mime,
    },
    body: binario,
  });
  if (!rUpload.ok) {
    console.error(`[SUBIR-CEDULA] Error subiendo ${tipo} a Storage:`, await rUpload.text());
    return json({ ok: false, error: 'No se pudo subir la foto' }, 500);
  }

  const rUpdate = await fetch(`${SUPABASE_URL}/rest/v1/clientes?cedula=eq.${encodeURIComponent(cedula)}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ [columna]: path }),
  });
  if (!rUpdate.ok) {
    console.error(`[SUBIR-CEDULA] Error vinculando ${tipo} al cliente:`, await rUpdate.text());
    return json({ ok: false, error: 'Foto subida pero no se pudo vincular al cliente' }, 500);
  }

  return json({ ok: true });
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return bytes;
}

// ============================================================================
// FEATURE 22-jul-2026 · Reportes diarios por WhatsApp
// Documento: FEATURE_ReportesDiarios_WhatsApp_22jul2026.md
//
// Cron cada 5 min (11am–7pm Colombia). En cada corrida:
//   1) Si ya se envió el reporte hoy → sale (idempotencia via reportes_diarios_enviados).
//   2) Calcula si todas las tiendas propias activas cerraron caja.
//   3) Si aún no todas Y no ha pasado el límite (15:00 en dom/festivo, 19:00 el resto) → espera.
//   4) Si sí todas O ya pasó el límite → reserva atómicamente el envío del día
//      (INSERT en reportes_diarios_enviados; si colisiona por PK, otra corrida ya reservó).
//   5) Compone y envía 3 mensajes (gastos, ventas, caja) con 120s de separación
//      a Oscar (573002024083) y Mayte (573005516040).
//
// Reglas del CLAUDE.md respetadas:
//   - Uses service_role (bypass RLS) — el Worker no tiene sesión de usuario Supabase.
//   - Zona horaria Colombia (UTC-5) calculada con Intl.DateTimeFormat (America/Bogota),
//     no offset manual — respeta cualquier ajuste eventual de la TZ.
// ============================================================================

const DESTINATARIOS_REPORTES = ['573002024083', '573005516040']; // Oscar, Mayte
const TZ_COL = 'America/Bogota';
const SEPARACION_REPORTES_MS = 120_000; // 2 minutos entre reporte y reporte

// ─── Helpers de tiempo Colombia ────────────────────────────────────────

function fechaColombiaHoy(): string {
  // Intl con locale en-CA da formato YYYY-MM-DD, perfecto para columna date de Supabase.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ_COL, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function horaColombiaAhora(): { hh: number; mm: number; hhmm: string } {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ_COL, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const hh = Number(partes.find((p) => p.type === 'hour')?.value ?? '0');
  const mm = Number(partes.find((p) => p.type === 'minute')?.value ?? '0');
  // Cloudflare a veces devuelve "24" a medianoche — normalizar a "00".
  const hhNorm = hh === 24 ? 0 : hh;
  const hhmm = `${String(hhNorm).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  return { hh: hhNorm, mm, hhmm };
}

function fechaFormateadaLarga(fechaISO: string): string {
  // "2026-07-22" → "martes 22 de julio de 2026"
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12)); // mediodía UTC para evitar deriva
  return new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ_COL, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(dt);
}

async function esDomingoOFestivo(fechaISO: string, env: Env): Promise<boolean> {
  // Domingo: Intl devuelve "Sunday"/"domingo" — usar getUTCDay sobre fecha normalizada.
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 17)); // 12pm Colombia = 5pm UTC
  if (dt.getUTCDay() === 0) return true;
  // Festivo: consulta a festivos_colombia.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/festivos_colombia?fecha=eq.${fechaISO}&select=fecha&limit=1`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) {
    console.error('[REPORTES-DIARIOS] Error consultando festivos:', await r.text());
    return false; // en duda, tratar como día normal (más conservador con el envío)
  }
  const arr = (await r.json()) as any[];
  return arr.length > 0;
}

// ─── Query helpers (todo lee de creditek-erp con service_role) ───────────

async function obtenerTiendasPropiasActivas(env: Env): Promise<Array<{ codigo: string; nombre: string }>> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/origenes?tipo=eq.propia&activo=eq.true&select=codigo,nombre&order=codigo`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error('No se pudieron cargar las tiendas: ' + (await r.text()));
  return (await r.json()) as any[];
}

async function obtenerCerradasHoy(fechaISO: string, env: Env): Promise<string[]> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/caja_diaria?fecha=eq.${fechaISO}&estado=eq.cerrada&select=tienda_codigo`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error('No se pudieron cargar cierres de caja: ' + (await r.text()));
  const arr = (await r.json()) as any[];
  return arr.map((x) => x.tienda_codigo);
}

async function obtenerGastosHoy(fechaISO: string, env: Env): Promise<Array<any>> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/gastos?fecha=eq.${fechaISO}&estado=eq.aprobado` +
      `&select=monto,descripcion,tienda_codigo,concepto:concepto_id(nombre),origen:tienda_codigo(nombre)` +
      `&order=tienda_codigo`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error('No se pudieron cargar gastos: ' + (await r.text()));
  return (await r.json()) as any[];
}

async function obtenerVentasHoy(fechaISO: string, env: Env): Promise<Array<any>> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/ventas?fecha=eq.${fechaISO}&anulada=not.is.true` +
      `&select=total,tienda_codigo,origen:tienda_codigo(nombre)`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error('No se pudieron cargar ventas: ' + (await r.text()));
  return (await r.json()) as any[];
}

async function obtenerCajaHoy(fechaISO: string, env: Env): Promise<Array<any>> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/caja_diaria?fecha=eq.${fechaISO}&estado=eq.cerrada` +
      `&select=efectivo_contado,efectivo_esperado,diferencia,tienda_codigo,origen:tienda_codigo(nombre)` +
      `&order=tienda_codigo`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) throw new Error('No se pudieron cargar cierres: ' + (await r.text()));
  return (await r.json()) as any[];
}

// Devuelve true si logró reservar (fila insertada), false si ya existía la del día.
async function reservarEnvioDelDia(
  fechaISO: string, completo: boolean, tiendasFaltantes: string[], env: Env
): Promise<boolean> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/reportes_diarios_enviados`, {
    method: 'POST',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ fecha: fechaISO, completo, tiendas_faltantes: tiendasFaltantes }),
  });
  if (r.status === 201) return true; // creado ok
  if (r.status === 409) return false; // duplicate key — otro cron reservó primero
  console.error('[REPORTES-DIARIOS] Error inesperado reservando:', r.status, await r.text());
  return false;
}

async function yaSeEnvioHoy(fechaISO: string, env: Env): Promise<boolean> {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/reportes_diarios_enviados?fecha=eq.${fechaISO}&select=fecha&limit=1`,
    { headers: sbHeaders(env) }
  );
  if (!r.ok) return false;
  const arr = (await r.json()) as any[];
  return arr.length > 0;
}

// ─── Formato de mensajes (WhatsApp texto plano) ──────────────────────────

function fmtCOP(n: number): string {
  return '$' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n || 0);
}

function encabezadoEstado(
  completo: boolean, nombresFaltantes: string[], hhmm: string
): string {
  return completo
    ? '✅ Las tiendas cerraron caja'
    : `⚠️ Falta cerrar caja: ${nombresFaltantes.join(', ')} (enviado a las ${hhmm})`;
}

function formatearGastos(
  gastos: any[], fechaLarga: string, encabezado: string
): string {
  const lineas = gastos.map((g) => {
    const tienda = g.origen?.nombre || g.tienda_codigo;
    const concepto = g.concepto?.nombre || '—';
    const desc = g.descripcion ? ` — ${g.descripcion}` : '';
    return `• ${tienda}: ${fmtCOP(Number(g.monto))} — ${concepto}${desc}`;
  });
  const total = gastos.reduce((s, g) => s + Number(g.monto || 0), 0);
  const body = lineas.length ? lineas.join('\n') : '_Sin gastos aprobados el día de hoy._';
  return [
    `📊 *GASTOS DE HOY* — ${fechaLarga}`,
    encabezado,
    '',
    body,
    '',
    `*Total del día:* ${fmtCOP(total)}`,
  ].join('\n');
}

function formatearVentas(ventas: any[], fechaLarga: string): string {
  // Agrupar por tienda
  const porTienda: Record<string, { nombre: string; num: number; total: number }> = {};
  for (const v of ventas) {
    const cod = v.tienda_codigo;
    if (!porTienda[cod]) porTienda[cod] = { nombre: v.origen?.nombre || cod, num: 0, total: 0 };
    porTienda[cod].num += 1;
    porTienda[cod].total += Number(v.total || 0);
  }
  const filas = Object.values(porTienda)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    .map((t) => `• ${t.nombre}: ${t.num} ventas — ${fmtCOP(t.total)}`);
  const totalOps = ventas.length;
  const totalVal = ventas.reduce((s, v) => s + Number(v.total || 0), 0);
  const body = filas.length ? filas.join('\n') : '_Sin ventas registradas el día de hoy._';
  return [
    `💰 *VENTAS DE HOY* — ${fechaLarga}`,
    '',
    body,
    '',
    `*Total vendido:* ${fmtCOP(totalVal)}  ·  *Operaciones:* ${totalOps}`,
  ].join('\n');
}

function formatearCaja(cierres: any[], fechaLarga: string): string {
  const lineas = cierres.map((c) => {
    const nombre = c.origen?.nombre || c.tienda_codigo;
    const efectivo = fmtCOP(Number(c.efectivo_contado || 0));
    const diff = Number(c.diferencia || 0);
    const marca = diff === 0
      ? ''
      : ` ⚠️ Diferencia: ${diff > 0 ? '+' : ''}${fmtCOP(diff)}`;
    return `• ${nombre}: ${efectivo} disponible${marca}`;
  });
  const total = cierres.reduce((s, c) => s + Number(c.efectivo_contado || 0), 0);
  const body = lineas.length ? lineas.join('\n') : '_Ninguna caja cerrada aún._';
  return [
    `💵 *CIERRE DE CAJA* — ${fechaLarga}`,
    '',
    body,
    '',
    `*Total efectivo en tiendas:* ${fmtCOP(total)}`,
  ].join('\n');
}

// ─── WhatsApp text send (mismo patrón que meta.ts del creditek-bot) ─────

async function enviarWhatsAppTexto(telefono: string, mensaje: string, env: Env): Promise<void> {
  const r = await fetch(`https://graph.facebook.com/v21.0/${env.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono.replace('+', ''),
      type: 'text',
      text: { body: mensaje, preview_url: false },
    }),
  });
  if (!r.ok) {
    // 24h window cerrado → Meta responde 403/400. Log claro para poder migrar a plantilla si se vuelve recurrente.
    console.error(`[REPORTES-WA] Error enviando a ${telefono}:`, r.status, await r.text());
  }
}

async function enviarReporteATodos(mensaje: string, env: Env): Promise<void> {
  for (const dest of DESTINATARIOS_REPORTES) {
    await enviarWhatsAppTexto(dest, mensaje, env);
  }
}

function esperar(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ─── Entry point del scheduled ──────────────────────────────────────────

async function ejecutarReportesDiarios(env: Env): Promise<void> {
  const hoy = fechaColombiaHoy();
  const { hh, mm, hhmm } = horaColombiaAhora();

  // Ventana operativa (11:00–19:55 Col). El cron sí corre otras horas por el rango UTC de wrangler.toml,
  // pero afuera de esta ventana no hay nada que reportar y salimos rápido para no gastar CPU.
  const minutosDelDia = hh * 60 + mm;
  if (minutosDelDia < 11 * 60 || minutosDelDia > 19 * 60 + 55) return;

  // Idempotencia rápida por consulta (chequeo optimista; la reserva atómica es la definitiva).
  if (await yaSeEnvioHoy(hoy, env)) return;

  let tiendas: Array<{ codigo: string; nombre: string }>;
  let cerradas: string[];
  try {
    [tiendas, cerradas] = await Promise.all([
      obtenerTiendasPropiasActivas(env),
      obtenerCerradasHoy(hoy, env),
    ]);
  } catch (e) {
    console.error('[REPORTES-DIARIOS] error en carga inicial:', e);
    return;
  }
  const codigos = tiendas.map((t) => t.codigo);
  const faltantes = codigos.filter((c) => !cerradas.includes(c));
  const nombresFaltantes = tiendas.filter((t) => faltantes.includes(t.codigo)).map((t) => t.nombre);

  // Decidir si es hora de enviar
  const domingoOFestivo = await esDomingoOFestivo(hoy, env);
  const limiteHora = domingoOFestivo ? 15 : 19;
  const debeMandarCompleto = faltantes.length === 0;
  const debeMandarIncompleto = !debeMandarCompleto && hh >= limiteHora;
  if (!debeMandarCompleto && !debeMandarIncompleto) return;

  // Reserva ATÓMICA — evita duplicados si dos crons corren muy juntos.
  const reservado = await reservarEnvioDelDia(hoy, debeMandarCompleto, faltantes, env);
  if (!reservado) return;

  // Componer mensajes
  const [gastos, ventas, cajas] = await Promise.all([
    obtenerGastosHoy(hoy, env),
    obtenerVentasHoy(hoy, env),
    obtenerCajaHoy(hoy, env),
  ]);
  const fechaLarga = fechaFormateadaLarga(hoy);
  const encabezado = encabezadoEstado(debeMandarCompleto, nombresFaltantes, hhmm);

  const msg1 = formatearGastos(gastos, fechaLarga, encabezado);
  const msg2 = formatearVentas(ventas, fechaLarga);
  const msg3 = formatearCaja(cajas, fechaLarga);

  // Enviar con separación de 2 min. El scheduled event de Cloudflare permite
  // wall time > CPU time; los 4 minutos de esperas son sleep, no CPU.
  console.log('[REPORTES-DIARIOS] Enviando reporte del', hoy, 'completo=', debeMandarCompleto);
  await enviarReporteATodos(msg1, env);
  await esperar(SEPARACION_REPORTES_MS);
  await enviarReporteATodos(msg2, env);
  await esperar(SEPARACION_REPORTES_MS);
  await enviarReporteATodos(msg3, env);
  console.log('[REPORTES-DIARIOS] Reporte del', hoy, 'enviado a los 2 destinatarios.');
}
