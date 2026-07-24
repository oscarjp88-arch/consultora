import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPublic } from '../../scripts/build-public.mjs';
import { verifyPublicArtifact } from '../../scripts/verify-public-artifact.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('build keeps required public applications and excludes backend source', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'creditek-public-'));
  await buildPublic(root, out);
  await verifyPublicArtifact(out);

  const required = [
    'creditek/agentes/index.html',
    'creditek/agentes/creditek-agente-redes.html',
    'creditek/agentes/creditek-agente-respuestas.html',
    'creditek/agentes/agente3-meta-ads.html',
    'creditek/agentes/creditek-agente-calendario.html',
    'creditek/portal/index.html',
    'creditek/agentes/creditek-gbp-fichas.html',
    'creditek/convenios/index.html',
    'creditek/erp/app.html',
    'creditek/legal/index.html',
  ];

  for (const relative of required) {
    assert.equal((await stat(path.join(out, relative))).isFile(), true, relative);
  }

  const portalHtml = await readFile(path.join(out, 'creditek/portal/index.html'), 'utf8');
  assert.match(portalHtml, /Portal de Pedidos/i);
});

test('build does not publish known server-only paths', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'creditek-public-'));
  await buildPublic(root, out);

  const forbidden = [
    'creditek/portal/Code.gs',
    'creditek/workers/gemini-proxy/wif-private.pem',
    'creditek/workers/gemini-proxy/index.js',
    'creditek/erp/scripts/crear_admins.mjs',
    'creditek/erp/tests/smoke_test_bodega_central_v1.sql',
  ];

  for (const relative of forbidden) {
    await assert.rejects(stat(path.join(out, relative)), { code: 'ENOENT' });
  }
});
