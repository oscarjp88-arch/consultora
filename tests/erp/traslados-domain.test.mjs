import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const source = await readFile(path.join(root, 'creditek/erp/traslados-domain.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const traslados = context.window.CreditekTrasladosDomain;

const traslado = { estado: 'despachado', tienda_origen: 'CK-02', tienda_destino: 'CK-03' };

test('solo la tienda destino puede recibir un traslado despachado', () => {
  assert.equal(traslados.puedeRecibir({ rol: 'admin_tienda', tienda_codigo: 'CK-03' }, traslado), true);
  assert.equal(traslados.puedeRecibir({ rol: 'admin_tienda', tienda_codigo: 'CK-02' }, traslado), false);
  assert.equal(traslados.puedeRecibir({ rol: 'gerencia', tienda_codigo: null }, traslado), false);
});

test('un traslado recibido ya no puede confirmarse de nuevo', () => {
  assert.equal(
    traslados.puedeRecibir(
      { rol: 'admin_tienda', tienda_codigo: 'CK-03' },
      { ...traslado, estado: 'recibido' }
    ),
    false
  );
});
