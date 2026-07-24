import { chmod, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { webcrypto } from 'node:crypto';

const cryptoApi = globalThis.crypto ?? webcrypto;
const encoder = new TextEncoder();
const REGISTRATION_URL = 'https://registro.crediteksas.com/creditek/erp/registro?t=';
const SUPABASE_URL = 'https://jfkmiyvcdfbsbwchyvol.supabase.co';

function base64url(bytes) {
  return Buffer.from(bytes).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function hashToken(token, secret) {
  const key = await cryptoApi.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return base64url(new Uint8Array(await cryptoApi.subtle.sign('HMAC', key, encoder.encode(token))));
}

function opaqueToken() {
  return base64url(cryptoApi.getRandomValues(new Uint8Array(32)));
}

export function normalizeCaptadorName(name) {
  return String(name).trim().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').toLowerCase();
}

function isWorkOrigin(origin) {
  return origin && origin.activo === true && typeof origin.codigo === 'string' &&
    typeof origin.nombre === 'string' && origin.codigo !== 'CENTRAL';
}

/**
 * Builds an in-memory plan. `enlaces` is the only value intended for Supabase;
 * raw tokens occur only in `links`, which is reserved for the explicit output file.
 */
export async function buildSeedPlan({
  origins,
  captadores,
  tokenSecret,
  tokenFor = () => opaqueToken(),
  activeStoreLinkOrigins = new Set(),
}) {
  if (!tokenSecret) throw new Error('TOKEN_HASH_SECRET requerido');
  const workOrigins = (Array.isArray(origins) ? origins : []).filter(isWorkOrigin);
  const originCodes = new Set(workOrigins.map((origin) => origin.codigo));
  const seenCaptadores = new Set();
  const captadorPayloads = [];

  for (const captador of Array.isArray(captadores) ? captadores : []) {
    if (!captador || !originCodes.has(captador.origen_codigo) || typeof captador.nombre !== 'string') continue;
    const normalized = normalizeCaptadorName(captador.nombre);
    if (normalized.length < 2) continue;
    const key = `${captador.origen_codigo}\u0000${normalized}`;
    if (seenCaptadores.has(key)) continue;
    seenCaptadores.add(key);
    captadorPayloads.push({
      origen_codigo: captador.origen_codigo,
      nombre: captador.nombre.trim(),
      tipo: captador.tipo === 'tercero' ? 'tercero' : 'empleado',
      activo: true,
    });
  }

  const enlaces = [];
  const links = [];
  for (const origin of workOrigins) {
    if (activeStoreLinkOrigins.has(origin.codigo)) continue;
    const token = tokenFor(origin.codigo);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error('token_invalido');
    }
    const tokenHash = await hashToken(token, tokenSecret);
    enlaces.push({
      token_hash: tokenHash,
      token_sufijo: token.slice(-8),
      origen_codigo: origin.codigo,
      captador_id: null,
      activo: true,
    });
    links.push({ codigo: origin.codigo, nombre: origin.nombre, link: `${REGISTRATION_URL}${token}` });
  }
  return { captadores: captadorPayloads, enlaces, links };
}

function headers(secret) {
  return { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' };
}

async function fetchRows(path, secret) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: headers(secret) });
  if (!response.ok) throw new Error('lectura_supabase_fallida');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('respuesta_supabase_invalida');
  return rows;
}

async function writePrivateOutput(path, links) {
  const absolute = resolve(path);
  if (!absolute.startsWith('/tmp/')) throw new Error('output_debe_estar_en_tmp');
  await writeFile(absolute, `${JSON.stringify(links, null, 2)}\n`, { mode: 0o600 });
  await chmod(absolute, 0o600);
}

function parseArgs(args) {
  const apply = args.includes('--apply');
  const dryRun = args.includes('--dry-run');
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (apply === dryRun || (apply && !output)) throw new Error('uso: --dry-run o --apply --output /tmp/archivo.json');
  return { apply, output };
}

async function postRows(table, rows, secret) {
  if (rows.length === 0) return;
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: { ...headers(secret), Prefer: 'return=minimal' }, body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error('escritura_supabase_fallida');
}

export async function runCli(args = process.argv.slice(2), env = process.env) {
  const { apply, output } = parseArgs(args);
  const secret = env.SUPABASE_SERVICE_KEY;
  if (apply && (!secret || !env.TOKEN_HASH_SECRET)) throw new Error('SUPABASE_SERVICE_KEY y TOKEN_HASH_SECRET requeridos para --apply');
  if (!secret || !env.TOKEN_HASH_SECRET) throw new Error('credenciales_requeridas_para_leer_origenes');

  const [origins, activeLinks] = await Promise.all([
    fetchRows('origenes?activo=eq.true&select=codigo,nombre,activo&order=codigo', secret),
    fetchRows('enlaces_registro?activo=eq.true&revoked_at=is.null&captador_id=is.null&select=origen_codigo', secret),
  ]);
  const plan = await buildSeedPlan({
    origins, captadores: [], tokenSecret: env.TOKEN_HASH_SECRET,
    activeStoreLinkOrigins: new Set(activeLinks.map((link) => link.origen_codigo)),
  });
  const codes = plan.links.map((link) => link.codigo).join(', ');
  if (!apply) {
    console.log(`Origenes planificados: ${plan.links.length}${codes ? ` (${codes})` : ''}`);
    return plan;
  }
  await postRows('captadores', plan.captadores, secret);
  await postRows('enlaces_registro', plan.enlaces, secret);
  await writePrivateOutput(output, plan.links);
  console.log(`Enlaces de registro creados: ${plan.links.length}`);
  return plan;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : 'error_de_siembra');
    process.exitCode = 1;
  });
}
