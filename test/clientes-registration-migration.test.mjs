import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path =
  'creditek/erp/migrations/20260723_clientes_enlaces_seguros.sql';

test('migration is additive and creates the secure registration contract', async () => {
  const sql = await readFile(path, 'utf8');
  for (const required of [
    'create table if not exists public.captadores',
    'create table if not exists public.enlaces_registro',
    'create table if not exists public.documentos_solicitud',
    'add column if not exists captador_id',
    'add column if not exists enlace_registro_id',
    'create or replace function public.crear_registro_cliente_seguro',
  ]) {
    assert.ok(sql.toLowerCase().includes(required), `missing: ${required}`);
  }
  assert.doesNotMatch(sql.toLowerCase(), /\bdrop\s+(table|column|schema)\b/);
  assert.doesNotMatch(sql.toLowerCase(), /\btruncate\b/);
});
