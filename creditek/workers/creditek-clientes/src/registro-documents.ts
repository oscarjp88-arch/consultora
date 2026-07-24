import { detectImage, verifySession } from './registro-security';

const SUPABASE_URL = 'https://jfkmiyvcdfbsbwchyvol.supabase.co';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const TYPE_COLUMNS: Record<string, string> = {
  frente: 'foto_cedula_frente_path', reverso: 'foto_cedula_reverso_path', selfie: 'selfie_cedula_path',
};

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface SecureDocumentsEnv { SUPABASE_SERVICE_KEY: string; REGISTRATION_SIGNING_SECRET: string }
export interface SecureDocumentsDependencies { fetcher: Fetcher; now?: () => number; randomUuid?: () => string }
export interface SecureDocumentsResult { status: number; body: Record<string, unknown> }

interface DocumentInput { documentos_session: string; cliente_id: string; solicitud_id: string; tipo: keyof typeof TYPE_COLUMNS; mime: 'image/jpeg' | 'image/png'; foto_base64: string }

function result(status: number, error?: string): SecureDocumentsResult { return error ? { status, body: { ok: false, error } } : { status, body: { ok: true } }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isInput(value: unknown): value is DocumentInput {
  return isRecord(value) && typeof value.documentos_session === 'string' && typeof value.cliente_id === 'string' && typeof value.solicitud_id === 'string' &&
    typeof value.tipo === 'string' && Object.prototype.hasOwnProperty.call(TYPE_COLUMNS, value.tipo) && (value.mime === 'image/jpeg' || value.mime === 'image/png') && typeof value.foto_base64 === 'string';
}
function headers(env: SecureDocumentsEnv, extra: Record<string, string> = {}): Record<string, string> { return { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, ...extra }; }
function decodedSize(value: string): number {
  return Math.floor(value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0);
}
function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0 || decodedSize(value) > MAX_IMAGE_BYTES) return null;
  try { const binary = atob(value); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); } catch { return null; }
}
async function sha256(bytes: Uint8Array): Promise<string> { const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''); }

export async function uploadSecureDocument(input: unknown, env: SecureDocumentsEnv, dependencies: SecureDocumentsDependencies): Promise<SecureDocumentsResult> {
  if (!isInput(input)) return result(400, 'Datos inválidos');
  let session;
  try { session = await verifySession(input.documentos_session, env.REGISTRATION_SIGNING_SECRET, (dependencies.now ?? Date.now)()); } catch { return result(400, 'Sesión de documentos inválida o vencida'); }
  if (session.purpose !== 'documentos' || !session.clienteId || !session.solicitudId || session.clienteId !== input.cliente_id || session.solicitudId !== input.solicitud_id) return result(400, 'Sesión de documentos inválida o vencida');
  const bytes = decodeBase64(input.foto_base64);
  if (bytes === null) return decodedSize(input.foto_base64) > MAX_IMAGE_BYTES ? result(413, 'La imagen supera el tamaño permitido') : result(400, 'Imagen inválida');
  const detected = detectImage(bytes);
  if (!detected || detected !== input.mime) return result(400, 'Imagen inválida');
  const extension = detected === 'image/png' ? 'png' : 'jpg';
  const randomUuid = dependencies.randomUuid
    ? dependencies.randomUuid()
    : crypto.randomUUID();
  const path = `${session.clienteId}/${session.solicitudId}/${input.tipo}-${randomUuid}.${extension}`;
  let uploaded: Response;
  try { uploaded = await dependencies.fetcher(`${SUPABASE_URL}/storage/v1/object/cedulas/${path}`, { method: 'POST', headers: headers(env, { 'Content-Type': detected }), body: bytes }); } catch { return result(502, 'No se pudo subir la imagen'); }
  if (!uploaded.ok) return result(502, 'No se pudo subir la imagen');
  let metadata: Response;
  try { metadata = await dependencies.fetcher(`${SUPABASE_URL}/rest/v1/documentos_solicitud?on_conflict=solicitud_id%2Ctipo`, { method: 'POST', headers: headers(env, { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify({ solicitud_id: session.solicitudId, cliente_id: session.clienteId, tipo: input.tipo, storage_path: path, mime: detected, tamano_bytes: bytes.length, sha256: await sha256(bytes) }) }); } catch { return result(502, 'No se pudo vincular la imagen'); }
  if (!metadata.ok) return result(502, 'No se pudo vincular la imagen');
  let legacy: Response;
  try { legacy = await dependencies.fetcher(`${SUPABASE_URL}/rest/v1/clientes?id=eq.${encodeURIComponent(session.clienteId)}&select=id`, { method: 'PATCH', headers: headers(env, { 'Content-Type': 'application/json', Prefer: 'return=representation' }), body: JSON.stringify({ [TYPE_COLUMNS[input.tipo]]: path }) }); } catch { return result(502, 'No se pudo vincular la imagen'); }
  if (!legacy.ok) return result(502, 'No se pudo vincular la imagen');
  try {
    const rows: unknown = await legacy.json();
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0]) || rows[0].id !== session.clienteId) {
      return result(502, 'No se pudo vincular la imagen');
    }
  } catch {
    return result(502, 'No se pudo vincular la imagen');
  }
  return result(200);
}
