import {
  assertCaptadorAllowed,
  resolveRegistrationContext,
} from './registro-context';
import { signSession, verifySession } from './registro-security';

const SUPABASE_URL = 'https://jfkmiyvcdfbsbwchyvol.supabase.co';
const SESSION_TTL_MS = 30 * 60_000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SecureRegistrationEnv {
  SUPABASE_SERVICE_KEY: string;
  TOKEN_HASH_SECRET: string;
  REGISTRATION_SIGNING_SECRET: string;
}

export interface SecureRegistrationResult {
  status: number;
  body: Record<string, unknown>;
}

export interface SecureRegistrationDependencies {
  fetcher: Fetcher;
  now?: () => number;
}

interface SecureRegistrationInput {
  enlace_token: string;
  captador_id: string;
  registro_session: string;
  nombre_completo: string;
  email?: string | null;
  ciudad: string;
  direccion: string;
  producto_interes: string;
  financiera?: string | null;
  referencias: Array<{ nombre: string; telefono: string; parentesco?: string | null }>;
  autorizacion_datos: true;
  autorizacion_comercial: boolean;
  autorizacion_version: string;
}

interface RegistrationRow { cliente_id: string; solicitud_id: string }
interface RegistrationReference { nombre: string; telefono: string; parentesco?: string | null }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function result(status: number, error?: string): SecureRegistrationResult {
  return error ? { status, body: { ok: false, error } } : { status, body: { ok: true } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isReference(value: unknown): value is RegistrationReference {
  if (!isRecord(value)) return false;
  return (
    typeof value.nombre === 'string' && value.nombre.trim().length >= 2 &&
    typeof value.telefono === 'string' && /^3\d{9}$/.test(value.telefono) &&
    (value.parentesco === undefined || value.parentesco === null || typeof value.parentesco === 'string')
  );
}

export function isSecureRegistrationRequest(value: unknown): boolean {
  return isRecord(value) && (
    hasOwn(value, 'enlace_token') || hasOwn(value, 'captador_id') || hasOwn(value, 'registro_session')
  );
}

function isInput(value: unknown): value is SecureRegistrationInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.enlace_token === 'string' && value.enlace_token.length >= 32 &&
    typeof value.captador_id === 'string' && value.captador_id.length > 0 &&
    typeof value.registro_session === 'string' && value.registro_session.length > 0 &&
    typeof value.nombre_completo === 'string' && value.nombre_completo.trim().length >= 3 &&
    (value.email === undefined || value.email === null || typeof value.email === 'string') &&
    typeof value.ciudad === 'string' && value.ciudad.trim().length >= 2 &&
    typeof value.direccion === 'string' && value.direccion.trim().length >= 3 &&
    typeof value.producto_interes === 'string' &&
    (value.financiera === undefined || value.financiera === null || typeof value.financiera === 'string') &&
    Array.isArray(value.referencias) && value.referencias.every(isReference) && value.autorizacion_datos === true &&
    typeof value.autorizacion_comercial === 'boolean' &&
    typeof value.autorizacion_version === 'string' && value.autorizacion_version.length > 0
  );
}

function isRegistrationRow(value: unknown): value is RegistrationRow {
  if (!isRecord(value)) return false;
  return typeof value.cliente_id === 'string' && UUID_PATTERN.test(value.cliente_id) &&
    typeof value.solicitud_id === 'string' && UUID_PATTERN.test(value.solicitud_id);
}

function headers(env: SecureRegistrationEnv): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

export async function submitSecureRegistration(
  input: unknown,
  env: SecureRegistrationEnv,
  dependencies: SecureRegistrationDependencies,
): Promise<SecureRegistrationResult> {
  if (!isInput(input)) return result(400, 'Datos inválidos');
  const now = (dependencies.now ?? Date.now)();

  let session;
  try {
    session = await verifySession(input.registro_session, env.REGISTRATION_SIGNING_SECRET, now);
  } catch {
    return result(400, 'Sesión de registro inválida o vencida');
  }
  if (session.purpose !== 'registro' || !session.otpId) {
    return result(400, 'Sesión de registro inválida o vencida');
  }

  let context;
  try {
    context = await resolveRegistrationContext(input.enlace_token, env, dependencies.fetcher);
    assertCaptadorAllowed(context, input.captador_id);
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    return code === 'enlace_invalido' || code === 'origen_invalido' || code === 'captador_invalido'
      ? result(400, 'Enlace o captador inválido')
      : result(503, 'No se pudo validar el enlace');
  }
  if (context.enlaceId !== session.enlaceId) {
    return result(400, 'Sesión de registro inválida o vencida');
  }

  let response: Response;
  try {
    response = await dependencies.fetcher(
      `${SUPABASE_URL}/rest/v1/rpc/crear_registro_cliente_seguro`,
      {
        method: 'POST', headers: headers(env),
        body: JSON.stringify({
          p_cedula: session.cedula,
          p_nombre_completo: input.nombre_completo,
          p_celular: session.celular,
          p_email: input.email ?? null,
          p_ciudad: input.ciudad,
          p_direccion: input.direccion,
          p_origen_codigo: context.origen.codigo,
          p_captador_id: input.captador_id,
          p_enlace_registro_id: context.enlaceId,
          p_otp_id: session.otpId,
          p_producto_interes: input.producto_interes,
          p_financiera: input.financiera ?? null,
          p_referencias: input.referencias.slice(0, 2),
          p_autorizacion_comercial: input.autorizacion_comercial,
          p_autorizacion_version: input.autorizacion_version,
        }),
      },
    );
  } catch {
    return result(503, 'No se pudo guardar el registro');
  }
  if (!response.ok) return result(response.status >= 400 && response.status < 500 ? 400 : 503, 'No se pudo guardar el registro');

  let rows: unknown;
  try { rows = await response.json(); } catch { return result(503, 'No se pudo guardar el registro'); }
  if (!Array.isArray(rows) || rows.length !== 1 || !isRegistrationRow(rows[0])) {
    return result(503, 'No se pudo guardar el registro');
  }

  try {
    const documentosSession = await signSession({
      purpose: 'documentos', cedula: session.cedula, celular: session.celular,
      enlaceId: context.enlaceId, clienteId: rows[0].cliente_id,
      solicitudId: rows[0].solicitud_id, exp: now + SESSION_TTL_MS,
    }, env.REGISTRATION_SIGNING_SECRET);
    return { status: 200, body: { ok: true, documentos_session: documentosSession } };
  } catch {
    return result(503, 'No se pudo crear la sesión de documentos');
  }
}
