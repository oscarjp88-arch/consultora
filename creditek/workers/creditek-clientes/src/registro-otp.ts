import { resolveRegistrationContext } from './registro-context';
import {
  generateOtp,
  hashOpaqueToken,
  signSession,
  verifyOpaqueToken,
} from './registro-security';

const SUPABASE_URL = 'https://jfkmiyvcdfbsbwchyvol.supabase.co';
const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_HOSTNAME = 'registro.crediteksas.com';
const TURNSTILE_ACTION = 'registro-cliente';
const OTP_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 30 * 60_000;
const RATE_WINDOW_MS = 60 * 60_000;
const MAX_PHONE_SENDS_PER_WINDOW = 3;
const MAX_LINK_SENDS_PER_WINDOW = 60;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface SecureOtpEnv {
  SUPABASE_SERVICE_KEY: string;
  TOKEN_HASH_SECRET: string;
  REGISTRATION_SIGNING_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
}

export interface SecureOtpResult {
  status: number;
  body: Record<string, unknown>;
}

export type OtpSender = (
  celular: string,
  codigo: string,
) => Promise<boolean>;

export interface SecureOtpSendDependencies {
  fetcher: Fetcher;
  sendOtp: OtpSender;
  now?: () => number;
  generateCode?: () => string;
}

export interface SecureOtpVerifyDependencies {
  fetcher: Fetcher;
  now?: () => number;
}

interface SecureOtpSendInput {
  enlace_token: string;
  cedula: string;
  celular: string;
  turnstile_token: string;
}

interface SecureOtpVerifyInput {
  enlace_token: string;
  cedula: string;
  celular: string;
  codigo: string;
}

interface OtpRow {
  id: string;
  codigo_hash: string;
  intentos: number;
}

function result(
  status: number,
  error?: string,
): SecureOtpResult {
  return error
    ? { status, body: { ok: false, error } }
    : { status, body: { ok: true } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, name);
}

export function isSecureOtpSendRequest(value: unknown): boolean {
  return isRecord(value) && (
    hasOwn(value, 'enlace_token') ||
    hasOwn(value, 'cedula') ||
    hasOwn(value, 'turnstile_token')
  );
}

export function isSecureOtpVerifyRequest(value: unknown): boolean {
  return isRecord(value) && (
    hasOwn(value, 'enlace_token') ||
    hasOwn(value, 'cedula')
  );
}

function isCedula(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6,12}$/.test(value);
}

function isCelular(value: unknown): value is string {
  return typeof value === 'string' && /^3\d{9}$/.test(value);
}

function isCodigo(value: unknown): value is string {
  return typeof value === 'string' && /^\d{6}$/.test(value);
}

function isSecureSendInput(value: unknown): value is SecureOtpSendInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.enlace_token === 'string' &&
    value.enlace_token.length >= 32 &&
    isCedula(value.cedula) &&
    isCelular(value.celular) &&
    typeof value.turnstile_token === 'string' &&
    value.turnstile_token.length > 0
  );
}

function isSecureVerifyInput(
  value: unknown,
): value is SecureOtpVerifyInput {
  if (!isRecord(value)) return false;
  return (
    typeof value.enlace_token === 'string' &&
    value.enlace_token.length >= 32 &&
    isCedula(value.cedula) &&
    isCelular(value.celular) &&
    isCodigo(value.codigo)
  );
}

function isOtpRow(value: unknown): value is OtpRow {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.codigo_hash === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value.codigo_hash) &&
    typeof value.intentos === 'number' &&
    Number.isInteger(value.intentos) &&
    value.intentos >= 0 &&
    value.intentos < 3
  );
}

function supabaseHeaders(
  env: SecureOtpEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function otpUrl(filters?: Record<string, string>): URL {
  const url = new URL(`${SUPABASE_URL}/rest/v1/otp_codigos`);
  if (filters) {
    for (const [name, value] of Object.entries(filters)) {
      url.searchParams.set(name, value);
    }
  }
  return url;
}

async function resolveContext(
  token: string,
  env: SecureOtpEnv,
  fetcher: Fetcher,
): Promise<
  | { ok: true; enlaceId: string }
  | { ok: false; response: SecureOtpResult }
> {
  try {
    const context = await resolveRegistrationContext(token, env, fetcher);
    return { ok: true, enlaceId: context.enlaceId };
  } catch (contextError) {
    const code =
      contextError instanceof Error ? contextError.message : '';
    if (
      code === 'enlace_invalido' ||
      code === 'origen_invalido' ||
      code === 'captador_invalido'
    ) {
      return {
        ok: false,
        response: result(404, 'Enlace inválido o vencido'),
      };
    }
    return {
      ok: false,
      response: result(503, 'No se pudo validar el enlace'),
    };
  }
}

export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
  secret: string,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  if (!token || !secret) return false;

  try {
    const response = await fetcher(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: remoteIp,
        idempotency_key: crypto.randomUUID(),
      }),
    });
    if (!response.ok) return false;

    const value: unknown = await response.json();
    if (!isRecord(value)) return false;
    return (
      value.success === true &&
      value.hostname === TURNSTILE_HOSTNAME &&
      value.action === TURNSTILE_ACTION
    );
  } catch {
    return false;
  }
}

async function countRecentOtps(
  filterName: 'celular' | 'enlace_registro_id',
  filterValue: string,
  since: string,
  env: SecureOtpEnv,
  fetcher: Fetcher,
): Promise<number | null> {
  const url = otpUrl({
    [filterName]: `eq.${filterValue}`,
    created_at: `gte.${since}`,
    select: 'id',
  });

  let response: Response;
  try {
    response = await fetcher(url, {
      headers: supabaseHeaders(env, {
        Prefer: 'count=exact',
        'Range-Unit': 'items',
        Range: '0-0',
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const contentRange = response.headers.get('Content-Range');
  const match = contentRange?.match(/\/(\d+)$/);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isSafeInteger(total) ? total : null;
}

export async function sendSecureOtp(
  input: unknown,
  remoteIp: string | null,
  env: SecureOtpEnv,
  dependencies: SecureOtpSendDependencies,
): Promise<SecureOtpResult> {
  if (!isSecureSendInput(input)) {
    return result(400, 'Datos inválidos');
  }

  const turnstileValid = await verifyTurnstile(
    input.turnstile_token,
    remoteIp,
    env.TURNSTILE_SECRET_KEY,
    dependencies.fetcher,
  );
  if (!turnstileValid) {
    return result(400, 'Verificación anti-robot inválida');
  }

  const resolved = await resolveContext(
    input.enlace_token,
    env,
    dependencies.fetcher,
  );
  if (!resolved.ok) return resolved.response;

  const now = (dependencies.now ?? Date.now)();
  const since = new Date(now - RATE_WINDOW_MS).toISOString();
  const phoneCount = await countRecentOtps(
    'celular',
    input.celular,
    since,
    env,
    dependencies.fetcher,
  );
  if (phoneCount === null) {
    return result(503, 'No se pudo validar el límite de envíos');
  }
  if (phoneCount >= MAX_PHONE_SENDS_PER_WINDOW) {
    return result(429, 'Límite de códigos alcanzado');
  }

  const linkCount = await countRecentOtps(
    'enlace_registro_id',
    resolved.enlaceId,
    since,
    env,
    dependencies.fetcher,
  );
  if (linkCount === null) {
    return result(503, 'No se pudo validar el límite de envíos');
  }
  if (linkCount >= MAX_LINK_SENDS_PER_WINDOW) {
    return result(429, 'Límite de códigos alcanzado');
  }

  const codigo = (dependencies.generateCode ?? generateOtp)();
  let codigoHash: string;
  try {
    codigoHash = await hashOpaqueToken(
      `otp:${codigo}`,
      env.TOKEN_HASH_SECRET,
    );
  } catch {
    return result(503, 'No se pudo generar el código');
  }

  let insertResponse: Response;
  try {
    insertResponse = await dependencies.fetcher(otpUrl(), {
      method: 'POST',
      headers: supabaseHeaders(env, { Prefer: 'return=minimal' }),
      body: JSON.stringify({
        cedula: input.cedula,
        celular: input.celular,
        enlace_registro_id: resolved.enlaceId,
        codigo_hash: codigoHash,
        expira_at: new Date(now + OTP_TTL_MS).toISOString(),
        intentos: 0,
        verificado: false,
      }),
    });
  } catch {
    return result(503, 'No se pudo generar el código');
  }
  if (!insertResponse.ok) {
    return result(503, 'No se pudo generar el código');
  }

  let sent = false;
  try {
    sent = await dependencies.sendOtp(input.celular, codigo);
  } catch {
    sent = false;
  }
  if (!sent) {
    return result(502, 'No se pudo enviar el código por WhatsApp');
  }

  return result(200);
}

async function readOtpRows(
  response: Response,
): Promise<unknown[] | null> {
  if (!response.ok) return null;
  try {
    const value: unknown = await response.json();
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function boundOtpFilters(
  input: SecureOtpVerifyInput,
  enlaceId: string,
  nowIso: string,
): Record<string, string> {
  return {
    cedula: `eq.${input.cedula}`,
    celular: `eq.${input.celular}`,
    enlace_registro_id: `eq.${enlaceId}`,
    verificado: 'eq.false',
    registro_consumido_at: 'is.null',
    expira_at: `gt.${nowIso}`,
  };
}

async function patchOtp(
  filters: Record<string, string>,
  body: Record<string, unknown>,
  env: SecureOtpEnv,
  fetcher: Fetcher,
): Promise<unknown[] | null> {
  let response: Response;
  try {
    response = await fetcher(otpUrl({ ...filters, select: 'id' }), {
      method: 'PATCH',
      headers: supabaseHeaders(env, { Prefer: 'return=representation' }),
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
  return readOtpRows(response);
}

export async function verifySecureOtp(
  input: unknown,
  env: SecureOtpEnv,
  dependencies: SecureOtpVerifyDependencies,
): Promise<SecureOtpResult> {
  if (!isSecureVerifyInput(input)) {
    return result(400, 'Datos inválidos');
  }

  const resolved = await resolveContext(
    input.enlace_token,
    env,
    dependencies.fetcher,
  );
  if (!resolved.ok) return resolved.response;

  const now = (dependencies.now ?? Date.now)();
  const nowIso = new Date(now).toISOString();
  const bindingFilters = boundOtpFilters(input, resolved.enlaceId, nowIso);

  let selectResponse: Response;
  try {
    selectResponse = await dependencies.fetcher(
      otpUrl({
        ...bindingFilters,
        intentos: 'lt.3',
        select: 'id,codigo_hash,intentos',
        order: 'created_at.desc',
        limit: '1',
      }),
      { headers: supabaseHeaders(env) },
    );
  } catch {
    return result(503, 'No se pudo verificar el código');
  }
  const rows = await readOtpRows(selectResponse);
  if (rows === null) {
    return result(503, 'No se pudo verificar el código');
  }
  if (rows.length !== 1 || !isOtpRow(rows[0])) {
    return result(400, 'Código vencido, consumido o no encontrado');
  }
  const otp = rows[0];

  const exactFilters = {
    id: `eq.${otp.id}`,
    ...bindingFilters,
    intentos: `eq.${otp.intentos}`,
    codigo_hash: `eq.${otp.codigo_hash}`,
  };

  const codeMatches = await verifyOpaqueToken(
    `otp:${input.codigo}`,
    otp.codigo_hash,
    env.TOKEN_HASH_SECRET,
  );
  if (!codeMatches) {
    const incremented = await patchOtp(
      exactFilters,
      { intentos: otp.intentos + 1 },
      env,
      dependencies.fetcher,
    );
    if (incremented === null) {
      return result(503, 'No se pudo verificar el código');
    }
    return result(400, 'Código incorrecto');
  }

  const updated = await patchOtp(
    exactFilters,
    { verificado: true },
    env,
    dependencies.fetcher,
  );
  if (
    updated === null ||
    updated.length !== 1 ||
    !isRecord(updated[0]) ||
    updated[0].id !== otp.id
  ) {
    return result(400, 'Código vencido, consumido o ya verificado');
  }

  let registroSession: string;
  try {
    registroSession = await signSession(
      {
        purpose: 'registro',
        cedula: input.cedula,
        celular: input.celular,
        enlaceId: resolved.enlaceId,
        otpId: otp.id,
        exp: now + SESSION_TTL_MS,
      },
      env.REGISTRATION_SIGNING_SECRET,
    );
  } catch {
    return result(503, 'No se pudo crear la sesión de registro');
  }

  return {
    status: 200,
    body: { ok: true, registro_session: registroSession },
  };
}
