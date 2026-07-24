import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const registro = await readFile('creditek/erp/registro.html', 'utf8');
const validacion = await readFile('creditek/erp/validacion.html', 'utf8');

test('registration requires a private token and never renders an origin catalog', () => {
  assert.match(
    registro,
    /new URLSearchParams\(location\.search\)[\s\S]*?get\('t'\)/,
  );
  assert.match(registro, /\/api\/registro\/contexto\?t=/);
  assert.match(registro, /id="linkBlockedScreen"/);
  assert.match(registro, /Enlace de registro inválido o vencido/);
  assert.doesNotMatch(registro, /id="origenSelect"/);
  assert.doesNotMatch(registro, /ORIGENES_FALLBACK/);
  assert.doesNotMatch(registro, /\/api\/origenes/);
  assert.doesNotMatch(registro, /id="vendedorNombre"/);
});

test('server context uses safe DOM rendering and represents every captator state', () => {
  assert.match(registro, /tiendaTag\.textContent\s*=/);
  assert.match(registro, /document\.createElement\('option'\)/);
  assert.match(registro, /option\.textContent\s*=/);
  assert.doesNotMatch(registro, /tiendaTag\.innerHTML\s*=/);
  assert.match(registro, /contexto\.tipo\s*===\s*'personal'/);
  assert.match(registro, /captadorSelect\.disabled\s*=\s*true/);
  assert.match(registro, /captadorSelect\.disabled\s*=\s*false/);
  assert.match(registro, /captadores\.length\s*===\s*0/);
  assert.match(registro, /No hay vendedores activos/);
});

test('registration uses address, Turnstile, and memory-only secure sessions', () => {
  assert.match(registro, /id="captadorSelect"/);
  assert.match(registro, /id="direccion"/);
  assert.match(registro, /\/api\/registro\/config/);
  assert.match(registro, /turnstile\.render/);
  assert.match(registro, /action:\s*'registro-cliente'/);
  assert.match(registro, /'expired-callback':\s*reiniciarTurnstile/);
  assert.match(registro, /let registroSession\s*=\s*null/);
  assert.match(registro, /let documentosSession\s*=\s*null/);
  assert.doesNotMatch(
    registro,
    /\b(?:localStorage|sessionStorage|document\.cookie|history\.pushState|history\.replaceState)\b/,
  );
  assert.doesNotMatch(registro, /TURNSTILE_SECRET|secret_key/i);
});

test('secure OTP and registration payloads contain no legacy trust fields', () => {
  assert.match(
    registro,
    /JSON\.stringify\(\{\s*enlace_token:\s*enlaceToken,\s*cedula:[\s\S]*?celular:[\s\S]*?turnstile_token:\s*turnstileToken\s*\}\)/,
  );
  assert.match(
    registro,
    /JSON\.stringify\(\{\s*enlace_token:\s*enlaceToken,\s*cedula:[\s\S]*?celular:[\s\S]*?codigo\s*\}\)/,
  );
  assert.match(registro, /registroSession\s*=\s*data\.registro_session/);
  assert.match(registro, /captador_id:\s*captadorSelect\.value/);
  assert.match(registro, /registro_session:\s*registroSession/);
  assert.match(registro, /direccion:/);
  assert.doesNotMatch(registro, /\borigen_codigo\b/);
  assert.doesNotMatch(registro, /\bvendedor_nombre\b/);
  assert.doesNotMatch(registro, /\botp_ok\b/);
});

test('document uploads use only the in-memory document session and file data', () => {
  assert.match(registro, /\/api\/documentos/);
  assert.match(
    registro,
    /JSON\.stringify\(\{\s*documentos_session:\s*documentosSession,\s*tipo,\s*mime:\s*'image\/jpeg',\s*foto_base64:\s*base64\s*\}\)/,
  );
  assert.doesNotMatch(registro, /\/api\/subir-cedula/);
  assert.doesNotMatch(registro, /cliente_id:\s*/);
  assert.doesNotMatch(registro, /solicitud_id:\s*/);
});

test('missing links, empty stores, OTP, registration, and upload failures stay distinct', () => {
  assert.match(registro, /mostrarBloqueoEnlace/);
  assert.match(registro, /mostrarErrorOtp/);
  assert.match(registro, /mostrarErrorRegistro/);
  assert.match(registro, /mostrarErrorDocumento/);
  assert.match(registro, /let registroEnCurso\s*=\s*false/);
  assert.match(registro, /let subidaFotosEnCurso\s*=\s*false/);
  assert.match(registro, /reiniciarTurnstile\(\)/);
});

test('excluded financing fields remain absent from client registration', () => {
  for (const id of [
    'valorFinanciado',
    'numeroCuotas',
    'valorCuota',
    'tasaInteres',
  ]) {
    assert.doesNotMatch(registro, new RegExp(`id="${id}"`));
  }
});

test('validation prefers request-scoped documents with legacy fallback', () => {
  assert.match(
    validacion,
    /\.select\('.*, documentos_solicitud\(\*\)'\)/,
  );
  assert.match(validacion, /sol\.documentos_solicitud\s*\|\|\s*\[\]/);
  assert.match(
    validacion,
    /\.find\(documento\s*=>\s*documento\.tipo\s*===\s*tipo\)/,
  );
  assert.match(validacion, /foto_cedula_frente_path/);
  assert.match(validacion, /foto_cedula_reverso_path/);
  assert.match(validacion, /selfie_cedula_path/);
  assert.match(validacion, /createSignedUrl\(path,\s*300\)/);
  assert.doesNotMatch(validacion, /data-path=/);
});
