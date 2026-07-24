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

interface OtpReservationRow {
  otp_id: string;
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

function isOtpReservationRow(
  value: unknown,
): value is OtpReservationRow {
  return (
    isRecord(value) &&
    typeof value.otp_id === 'string' &&
    value.otp_id.length > 0
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

async function reserveOtp(
  input: SecureOtpSendInput,
  enlaceId: string,
  codigoHash: string,
  expiraAt: string,
  env: SecureOtpEnv,
  fetcher: Fetcher,
): Promise<
  | { ok: true; otpId: string }
  | { ok: false; quota: boolean }
> {
  let response: Response;
  try {
    response = await fetcher(
      `${SUPABASE_URL}/rest/v1/rpc/reservar_otp_registro_seguro`,
      {
        method: 'POST',
        headers: supabaseHeaders(env),
        body: JSON.stringify({
          p_cedula: input.cedula,
          p_celular: input.celular,
          p_enlace_registro_id: enlaceId,
          p_codigo_hash: codigoHash,
          p_expira_at: expiraAt,
        }),
      },
    );
  } catch {
    return { ok: false, quota: false };
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    return { ok: false, quota: false };
  }
  if (!response.ok) {
    return {
      ok: false,
      quota:
        responseText.includes('otp_limite_celular') ||
        responseText.includes('otp_limite_enlace'),
    };
  }

  try {
    const value: unknown = JSON.parse(responseText);
    if (
      !Array.isArray(value) ||
      value.length !== 1 ||
      !isOtpReservationRow(value[0])
    ) {
      return { ok: false, quota: false };
    }
    return { ok: true, otpId: value[0].otp_id };
  } catch {
    return { ok: false, quota: false };
  }
}

function deliveryFilters(
  input: SecureOtpSendInput,
  enlaceId: string,
  otpId: string,
): Record<string, string> {
  return {
    id: `eq.${otpId}`,
    cedula: `eq.${input.cedula}`,
    celular: `eq.${input.celular}`,
    enlace_registro_id: `eq.${enlaceId}`,
    envio_aceptado_at: 'is.null',
    envio_fallido_at: 'is.null',
  };
}

function isExactUpdatedRow(
  rows: unknown[] | null,
  expectedId: string,
): boolean {
  return (
    rows !== null &&
    rows.length === 1 &&
    isRecord(rows[0]) &&
    rows[0].id === expectedId
  );
}

async function closeDelivery(
  filters: Record<string, string>,
  field: 'envio_aceptado_at' | 'envio_fallido_at',
  timestamp: string,
  expectedId: string,
  env: SecureOtpEnv,
  fetcher: Fetcher,
): Promise<boolean> {
  const rows = await patchOtp(
    filters,
    { [field]: timestamp },
    env,
    fetcher,
  );
  return isExactUpdatedRow(rows, expectedId);
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

  const reservation = await reserveOtp(
    input,
    resolved.enlaceId,
    codigoHash,
    new Date(now + OTP_TTL_MS).toISOString(),
    env,
    dependencies.fetcher,
  );
  if (!reservation.ok) {
    return reservation.quota
      ? result(429, 'Límite de códigos alcanzado')
      : result(503, 'No se pudo reservar el código');
  }

  let sent = false;
  try {
    sent = await dependencies.sendOtp(input.celular, codigo);
  } catch {
    sent = false;
  }

  const timestamp = new Date(now).toISOString();
  const filters = deliveryFilters(
    input,
    resolved.enlaceId,
    reservation.otpId,
  );
  if (!sent) {
    const failureRecorded = await closeDelivery(
      filters,
      'envio_fallido_at',
      timestamp,
      reservation.otpId,
      env,
      dependencies.fetcher,
    );
    return failureRecorded
      ? result(502, 'No se pudo enviar el código por WhatsApp')
      : result(503, 'No se pudo cerrar el envío fallido');
  }

  const deliveryRecorded = await closeDelivery(
    filters,
    'envio_aceptado_at',
    timestamp,
    reservation.otpId,
    env,
    dependencies.fetcher,
  );
  if (!deliveryRecorded) {
    return result(503, 'No se pudo confirmar la entrega del código');
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
    envio_aceptado_at: 'not.is.null',
    envio_fallido_at: 'is.null',
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
