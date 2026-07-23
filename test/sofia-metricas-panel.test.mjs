import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const html = await readFile(
  new URL('../creditek/agentes/creditek-agente-respuestas.html', import.meta.url),
  'utf8',
);

test('muestra leads pendientes y transferidos como métricas distintas', () => {
  assert.match(html, /id="s-leads"[\s\S]*Leads pendientes/);
  assert.match(html, /id="s-transferidos"[\s\S]*Transferidos a asesor/);
});

test('consume los campos nuevos con compatibilidad hacia atrás', () => {
  assert.match(html, /d\.leads_pendientes\s*\?\?\s*d\.leads/);
  assert.match(html, /getElementById\('s-transferidos'\)\.textContent=d\.transferidos\s*\?\?\s*0/);
});
