import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const DOCUMENTO_HTML = new URL('../creditek/erp/documento-remision.html', import.meta.url);

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
}

function fakeElement() {
  return {
    value: '',
    textContent: '',
    className: '',
    disabled: false,
    files: [],
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener() {},
    appendChild() {},
    click() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function loadDocumentoPage() {
  const html = fs.readFileSync(DOCUMENTO_HTML, 'utf8');
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1, 'documento-remision.html debe tener un script principal');

  const elements = new Map();
  const rpcCalls = [];
  const traceRows = [
    {
      remision_item_id: 'item-1',
      factura_id: 'factura-1',
      numero: 'FV-101',
      fecha: '2026-07-23',
      proveedor: 'Proveedor Uno',
      costo_oscar: 340000,
    },
  ];
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
    },
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      if (name === 'obtener_trazabilidad_remision') {
        return { data: traceRows, error: null };
      }
      return { data: null, error: null };
    },
  };
  const document = {
    body: fakeElement(),
    createElement() { return fakeElement(); },
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement());
      return elements.get(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  const location = {
    href: '',
    search: '?remision_id=rem-123',
  };
  const window = {
    SB: sb,
    CREDITEK_ENV: undefined,
    location,
    open() {},
    print() {},
    scrollTo() {},
  };
  const context = vm.createContext({
    console,
    document,
    Intl,
    location,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    window,
  });

  vm.runInContext(scripts[0], context, { filename: 'documento-remision.html' });
  return { context, rpcCalls };
}

test('la tienda obtiene proveedor y factura mediante un RPC seguro sin cargar costos', async () => {
  const page = loadDocumentoPage();

  assert.equal(
    vm.runInContext('typeof cargarTrazabilidadRemision', page.context),
    'function',
  );
  await vm.runInContext("cargarTrazabilidadRemision('rem-123')", page.context);

  assert.deepEqual(JSON.parse(JSON.stringify(page.rpcCalls)), [{
    name: 'obtener_trazabilidad_remision',
    args: { p_remision_id: 'rem-123' },
  }]);
  assert.deepEqual(
    JSON.parse(vm.runInContext('JSON.stringify(trazabilidadFacturas)', page.context)),
    {
      'factura-1': {
        numero: 'FV-101',
        fecha: '2026-07-23',
        proveedor: 'Proveedor Uno',
      },
    },
  );
});
