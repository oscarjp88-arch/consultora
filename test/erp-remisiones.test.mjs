import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const REMISIONES_HTML = new URL('../creditek/erp/remisiones.html', import.meta.url);

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
}

function fakeElement(id = '') {
  const listeners = new Map();
  return {
    id,
    value: '',
    textContent: '',
    disabled: false,
    style: {},
    dataset: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    dispatch(type) {
      const handler = listeners.get(type);
      if (handler) handler({ target: this });
    },
    querySelector() { return fakeElement(); },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {},
  };
}

function loadRemisionesPage() {
  const html = fs.readFileSync(REMISIONES_HTML, 'utf8');
  const scripts = inlineScripts(html);
  assert.equal(scripts.length, 1, 'remisiones.html debe tener un script principal');

  const elements = new Map();
  const tbody = fakeElement('tbodyRemisiones');
  let tbodyHtml = '';
  let renderedViewButton = null;

  Object.defineProperty(tbody, 'innerHTML', {
    get() { return tbodyHtml; },
    set(value) {
      tbodyHtml = value;
      const match = value.match(/class="btn-ver" data-id="([^"]+)"/);
      renderedViewButton = match ? fakeElement('btn-ver') : null;
      if (renderedViewButton) renderedViewButton.dataset.id = match[1];
    },
  });
  tbody.querySelectorAll = (selector) => {
    if ((selector === '.btn-ver' || selector === '.btn-ver, .btn-editar') && renderedViewButton) {
      return [renderedViewButton];
    }
    return [];
  };
  elements.set('tbodyRemisiones', tbody);

  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id));
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    createElement() { return fakeElement(); },
  };

  const auth = {
    getSession: async () => ({ data: { session: null } }),
    signInWithPassword: async () => ({ data: {}, error: null }),
    signOut: async () => {},
  };
  const sb = { auth };
  const location = { href: '', reload() {} };
  const window = {};
  const context = vm.createContext({
    alert() {},
    confirm() { return true; },
    console,
    document,
    Intl,
    location,
    navigator: {},
    requestAnimationFrame() { return 1; },
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    supabase: { createClient: () => sb },
    window,
  });
  window.location = location;

  vm.runInContext(scripts[0], context, { filename: 'remisiones.html' });
  vm.runInContext(`
    remisionesCache = [{
      id: 'rem-123',
      consecutivo: 7,
      tienda_codigo: 'CK-02',
      estado: 'recibida',
      created_at: '2026-07-24T12:00:00Z',
      origenes: { nombre: 'Movil Shopping' },
      remision_items: [{ cantidad: 1, precio_remision: 390000 }]
    }];
    currentPerfil = { rol: 'admin_tienda', tienda_codigo: 'CK-02' };
    globalThis.modalAntiguoAbierto = false;
    abrirModalRemision = () => { globalThis.modalAntiguoAbierto = true; };
    renderTablaRemisiones();
  `, context);

  return {
    clickView() {
      assert.ok(renderedViewButton, 'la tabla debe renderizar el botón Ver');
      renderedViewButton.dispatch('click');
    },
    location,
    context,
  };
}

test('Ver abre el documento canónico de la remisión, no el modal antiguo', () => {
  const page = loadRemisionesPage();

  page.clickView();

  assert.equal(
    page.location.href,
    'documento-remision.html?remision_id=rem-123',
  );
  assert.equal(page.context.modalAntiguoAbierto, false);
});
