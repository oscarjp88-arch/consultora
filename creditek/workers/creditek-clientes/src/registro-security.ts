export type SessionPurpose = 'registro' | 'documentos';

export interface SessionPayload {
  purpose: SessionPurpose;
  cedula: string;
  celular: string;
  enlaceId: string;
  otpId?: string;
  clienteId?: string;
  solicitudId?: string;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const HMAC_LENGTH_BYTES = 32;
const OTP_SPACE = 1_000_000;
const UINT32_SPACE = 0x1_0000_0000;
const OTP_REJECTION_LIMIT =
  Math.floor(UINT32_SPACE / OTP_SPACE) * OTP_SPACE;

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function fromBase64url(value: string): Uint8Array {
  if (!value || !BASE64URL_PATTERN.test(value)) {
    throw new Error('sesion_invalida');
  }

  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);

  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(
      binary,
      (char) => char.charCodeAt(0),
    );
    if (base64url(bytes) !== value) {
      throw new Error('sesion_invalida');
    }
    return bytes;
  } catch {
    throw new Error('sesion_invalida');
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error('sesion_invalida');

  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(value),
  );
  return new Uint8Array(signature);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  return (
    (candidate.purpose === 'registro' ||
      candidate.purpose === 'documentos') &&
    typeof candidate.cedula === 'string' &&
    typeof candidate.celular === 'string' &&
    typeof candidate.enlaceId === 'string' &&
    isOptionalString(candidate.otpId) &&
    isOptionalString(candidate.clienteId) &&
    isOptionalString(candidate.solicitudId) &&
    typeof candidate.exp === 'number' &&
    Number.isFinite(candidate.exp)
  );
}

export function generateOpaqueToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new Error('longitud_token_invalida');
  }
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashOpaqueToken(
  raw: string,
  secret: string,
): Promise<string> {
  return base64url(await hmac(raw, secret));
}

export async function verifyOpaqueToken(
  raw: string,
  expectedHash: string,
  secret: string,
): Promise<boolean> {
  try {
    const signature = fromBase64url(expectedHash);
    if (signature.length !== HMAC_LENGTH_BYTES) return false;

    const key = await importHmacKey(secret);
    return crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(raw),
    );
  } catch {
    return false;
  }
}

export function generateOtp(): string {
  const values = new Uint32Array(1);
  let value: number;

  do {
    crypto.getRandomValues(values);
    value = values[0];
  } while (value >= OTP_REJECTION_LIMIT);

  return String(value % OTP_SPACE).padStart(6, '0');
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  if (!isSessionPayload(payload)) throw new Error('sesion_invalida');

  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64url(await hmac(body, secret))}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload> {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('sesion_invalida');

    const [body, encodedSignature] = parts;
    const signature = fromBase64url(encodedSignature);
    if (signature.length !== HMAC_LENGTH_BYTES) {
      throw new Error('sesion_invalida');
    }

    const key = await importHmacKey(secret);
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      encoder.encode(body),
    );
    if (!valid) throw new Error('sesion_invalida');

    const parsed = JSON.parse(
      decoder.decode(fromBase64url(body)),
    ) as unknown;
    if (!isSessionPayload(parsed)) throw new Error('sesion_invalida');
    if (parsed.exp < now) throw new Error('sesion_vencida');

    return parsed;
  } catch (error) {
    if (error instanceof Error && error.message === 'sesion_vencida') {
      throw error;
    }
    throw new Error('sesion_invalida');
  }
}

export function detectImage(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }

  const pngSignature = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ];
  if (
    bytes.length >= pngSignature.length &&
    pngSignature.every((value, index) => bytes[index] === value)
  ) {
    return 'image/png';
  }

  return null;
}
