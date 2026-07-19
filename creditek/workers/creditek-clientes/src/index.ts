/**
 * creditek-clientes — Worker de registro de clientes + OTP (Entregable 1)
 * SPEC_ClientesEntregable1_v1_15jul2026.md
 *
 * Separado por completo de creditek-bot (Sofía). No tocar ese Worker desde aquí.
 * Proyecto Supabase: creditek-erp (jfkmiyvcdfbsbwchyvol) — distinto del de Sofía.
 */

interface Env {
  SUPABASE_SERVICE_KEY: string;
  WHATSAPP_TOKEN: string;
  PHONE_NUMBER_ID: string;
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

// FIX CORS v23 de creditek-bot (mismo patrón, aplicado desde el día 1 aquí
// porque el propio documento de este entregable señala que este olvido ya
// rompió el Panel de Respuestas dos veces).
const cors: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: cors });
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
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/origenes' && request.method === 'GET') {
        return await handleOrigenes(env);
      }
      if (url.pathname === '/api/otp/enviar' && request.method === 'POST') {
        return await handleOtpEnviar(request, env);
      }
      if (url.pathname === '/api/otp/verificar' && request.method === 'POST') {
        return await handleOtpVerificar(request, env);
      }
      if (url.pathname === '/api/registro' && request.method === 'POST') {
        return await handleRegistro(request, env);
      }
      if (url.pathname === '/api/subir-cedula' && request.method === 'POST') {
        return await handleSubirCedula(request, env);
      }
      return json({ ok: false, error: 'Ruta no encontrada' }, 404);
    } catch (e) {
      console.error('[creditek-clientes] Error no controlado:', e);
      return json({ ok: false, error: 'Error interno' }, 500);
    }
  },
};

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
async function handleSubirCedula(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as any;
  const cedula = body?.cedula;
  const fotoBase64 = body?.foto_base64;
  const mime = body?.mime || 'image/jpeg';
  if (!cedulaValida(cedula) || typeof fotoBase64 !== 'string' || !fotoBase64) {
    return json({ ok: false, error: 'Datos inválidos' }, 400);
  }

  const ext = mime.includes('png') ? 'png' : 'jpg';
  const path = `${cedula}_${Date.now()}.${ext}`;

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
    console.error('[SUBIR-CEDULA] Error subiendo a Storage:', await rUpload.text());
    return json({ ok: false, error: 'No se pudo subir la foto' }, 500);
  }

  const rUpdate = await fetch(`${SUPABASE_URL}/rest/v1/clientes?cedula=eq.${encodeURIComponent(cedula)}`, {
    method: 'PATCH',
    headers: sbHeaders(env, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ foto_cedula_path: path }),
  });
  if (!rUpdate.ok) {
    console.error('[SUBIR-CEDULA] Error vinculando al cliente:', await rUpdate.text());
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
