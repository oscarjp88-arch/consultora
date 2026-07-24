import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path =
  'creditek/erp/migrations/20260723_clientes_enlaces_seguros.sql';

test('migration is additive and creates the secure registration contract', async () => {
  const sql = await readFile(path, 'utf8');
  const lower = sql.toLowerCase();
  for (const required of [
    'create table if not exists public.captadores',
    'create table if not exists public.enlaces_registro',
    'create table if not exists public.documentos_solicitud',
    'add column if not exists captador_id',
    'add column if not exists enlace_registro_id',
    'create or replace function public.crear_registro_cliente_seguro',
  ]) {
    assert.ok(lower.includes(required), `missing: ${required}`);
  }
  assert.doesNotMatch(lower, /\bdrop\s+(table|column|schema)\b/);
  assert.doesNotMatch(lower, /\btruncate\b/);
  assert.doesNotMatch(lower, /\bdelete\s+from\b/);

  const directUpdates = [...lower.matchAll(/^\s*update\s+public\.(\w+)/gm)]
    .map((match) => match[1]);
  assert.deepEqual(directUpdates, ['otp_codigos']);
});

test('link capturers are constrained to the link origin', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  assert.match(
    normalized,
    /unique \(id, origen_codigo\)/,
  );
  assert.match(
    normalized,
    /foreign key \(captador_id, origen_codigo\) references public\.captadores \(id, origen_codigo\)/,
  );
});

test('secure OTP rows require hashes and scrub the legacy plaintext column', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .replace(/\s+/g, ' ');

  assert.match(
    normalized,
    /constraint otp_codigos_registro_seguro_check check \( enlace_registro_id is null or \( codigo_hash is not null and codigo_hash ~ '\^\[A-Za-z0-9_-\]\{43\}\$' and codigo = 'HASHED' \) \)/,
  );
  assert.match(
    normalized,
    /create or replace function public\.proteger_otp_registro_seguro\(\)/,
  );
  assert.match(
    normalized,
    /if new\.enlace_registro_id is not null then/,
  );
  assert.match(normalized, /new\.codigo := 'HASHED'/);
  assert.match(
    normalized,
    /create or replace trigger otp_codigos_proteger_registro_seguro before insert or update/,
  );
});

test('request documents derive client attribution from the request', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  assert.match(
    normalized,
    /create unique index if not exists solicitudes_id_cliente_uidx on public\.solicitudes \(id, cliente_id\)/,
  );
  assert.match(
    normalized,
    /foreign key \(solicitud_id, cliente_id\) references public\.solicitudes \(id, cliente_id\)/,
  );
});

test('link lifecycle and suffix constraints prevent ambiguous or secret values', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  assert.match(normalized, /check \(activo = \(revoked_at is null\)\)/);
  assert.match(
    normalized,
    /token_sufijo text not null check \(token_sufijo ~ '\^\[a-za-z0-9_-\]\{4,12\}\$'\)/,
  );
});

test('RLS, RPC grants, and atomic OTP consumption remain explicit', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  for (const table of [
    'captadores',
    'enlaces_registro',
    'documentos_solicitud',
  ]) {
    assert.ok(
      normalized.includes(
        `alter table public.${table} enable row level security`,
      ),
      `missing RLS: ${table}`,
    );
    assert.ok(
      normalized.includes(`revoke all on public.${table} from anon`),
      `missing anon revoke: ${table}`,
    );
  }
  assert.match(
    normalized,
    /revoke all on function public\.crear_registro_cliente_seguro\([\s\S]*\) from public, anon, authenticated/,
  );
  assert.match(
    normalized,
    /grant execute on function public\.crear_registro_cliente_seguro\([\s\S]*\) to service_role/,
  );
  assert.match(
    normalized,
    /update public\.otp_codigos set registro_consumido_at = now\(\) where id = p_otp_id and cedula = p_cedula and celular = p_celular and enlace_registro_id = p_enlace_registro_id and verificado = true and registro_consumido_at is null and entregado_at is not null and envio_fallido_at is null and expira_at > now\(\) returning id into v_otp_id/,
  );
});

test('migration carries a deterministic live-schema preflight contract', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  assert.match(normalized, /information_schema\.columns/);
  assert.match(normalized, /from pg_catalog\.pg_index/);
  assert.match(normalized, /raise exception 'preflight_esquema_incompatible:%'/);
});

test('preflight rejects legacy OTP code columns shorter than the sentinel', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  assert.match(
    normalized,
    /expected\.table_name = 'otp_codigos' and expected\.column_name = 'codigo' and actual\.character_maximum_length is not null and actual\.character_maximum_length < 6/,
  );
});

test('preflight accepts only usable immediate cedula indexes', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const requiredFlags = [
    'indisvalid',
    'indisready',
    'indislive',
    'indimmediate',
  ];
  const missingFlags = requiredFlags.filter(
    (flag) => !normalized.includes(`and index_definition.${flag}`),
  );

  assert.deepEqual(missingFlags, []);
});

test('secure OTP reservation serializes quotas and records delivery state additively', async () => {
  const normalized = (await readFile(path, 'utf8'))
    .toLowerCase()
    .replace(/\s+/g, ' ');

  assert.match(
    normalized,
    /alter table public\.otp_codigos add column if not exists entregado_at timestamptz null/,
  );
  assert.match(
    normalized,
    /alter table public\.otp_codigos add column if not exists envio_fallido_at timestamptz null/,
  );
  assert.match(
    normalized,
    /create or replace function public\.reservar_otp_registro_seguro\(/,
  );
  assert.match(
    normalized,
    /pg_advisory_xact_lock\(\s*hashtextextended\('otp:celular:' \|\| p_celular, 0\)\s*\)/,
  );
  assert.match(
    normalized,
    /pg_advisory_xact_lock\(\s*hashtextextended\('otp:enlace:' \|\| p_enlace_registro_id::text, 0\)\s*\)/,
  );
  assert.match(
    normalized,
    /celular = p_celular and enlace_registro_id is not null and created_at >= now\(\) - interval '1 hour' and envio_fallido_at is null/,
  );
  assert.match(normalized, /if v_envios_celular >= 3 then/);
  assert.match(
    normalized,
    /enlace_registro_id = p_enlace_registro_id and created_at >= now\(\) - interval '1 hour' and envio_fallido_at is null/,
  );
  assert.match(normalized, /if v_envios_enlace >= 60 then/);
  assert.match(
    normalized,
    /insert into public\.otp_codigos \( cedula, celular, enlace_registro_id, codigo_hash, expira_at, intentos, verificado \)/,
  );
  assert.match(
    normalized,
    /grant execute on function public\.reservar_otp_registro_seguro\([\s\S]*\) to service_role/,
  );
});
