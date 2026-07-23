import test from 'node:test';
import assert from 'node:assert/strict';

const base = (process.env.BASE_URL || 'https://registro.crediteksas.com').replace(/\/$/, '');

const entrypoints = [
  ['/creditek/agentes/', 'CREDITEK'],
  ['/creditek/agentes/creditek-agente-redes.html', 'Agente'],
  ['/creditek/agentes/creditek-agente-respuestas.html', 'Sofía'],
  ['/creditek/agentes/agente3-meta-ads.html', 'Meta Ads'],
  ['/creditek/agentes/creditek-agente-calendario.html', 'Calendario'],
  ['/creditek/portal/', 'Portal de Pedidos'],
  ['/creditek/agentes/creditek-gbp-fichas.html', 'Google Business'],
  ['/creditek/convenios/', 'Convenio'],
];

for (const [path, expectedText] of entrypoints) {
  test(`GET ${path} remains available`, async () => {
    const response = await fetch(`${base}${path}`, { redirect: 'follow' });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, new RegExp(expectedText, 'i'));
  });
}

test('internal Apps Script source is not public', async () => {
  const response = await fetch(`${base}/creditek/portal/Code.gs`, { redirect: 'manual' });
  assert.equal(response.status, 404);
});

test('Gemini private key is not public', async () => {
  const response = await fetch(
    `${base}/creditek/workers/gemini-proxy/wif-private.pem`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 404);
});
