import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const source = await readFile(path.join(root, 'creditek/erp/inventario-domain.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const domain = context.window.CreditekInventarioDomain;

const unidades = [
  { id: 'u1', tienda_actual: 'CK-02', estado: 'disponible', precio_tienda: 364000, costo_remision: 344000 },
  { id: 'u2', tienda_actual: 'CK-02', estado: 'vendido', precio_tienda: 350000, costo_remision: 330000 },
  { id: 'u3', tienda_actual: 'CK-03', estado: 'disponible', precio_tienda: 500000, costo_remision: 450000 },
];

const stock = [
  { tienda_codigo: 'CK-02', cantidad: 7, precio_tienda: 15542.857, costo_promedio: 12700 },
  { tienda_codigo: 'CK-03', cantidad: 3, precio_tienda: 20000, costo_promedio: 16000 },
];

test('resumen cuenta solo unidades disponibles de la tienda elegida', () => {
  const resumen = domain.resumirInventario({ unidades, stock, tiendaCodigo: 'CK-02', esCentral: false });
  assert.equal(resumen.celularesDisponibles, 1);
  assert.equal(resumen.accesoriosDisponibles, 7);
  assert.equal(Math.round(resumen.valorTienda), 472800);
});

test('resumen central consolida todas las tiendas y separa costo interno', () => {
  const resumen = domain.resumirInventario({ unidades, stock, tiendaCodigo: '', esCentral: true });
  assert.equal(resumen.celularesDisponibles, 2);
  assert.equal(resumen.accesoriosDisponibles, 10);
  assert.equal(Math.round(resumen.valorTienda), 1032800);
  assert.equal(resumen.valorInterno, 930900);
});

test('una tienda nunca recibe costo interno como sustituto de su precio', () => {
  assert.equal(domain.valorVisibleUnidad({ precio_tienda: 120000, costo_remision: 90000 }, false), 120000);
  assert.equal(domain.valorVisibleUnidad({ precio_tienda: null, costo_remision: 90000 }, false), null);
  assert.equal(domain.valorVisibleStock({ precio_tienda: null, costo_promedio: 12000 }, false), null);
});

test('central sí puede ver costos internos', () => {
  assert.equal(domain.valorVisibleUnidad({ precio_tienda: 120000, costo_remision: 90000 }, true), 90000);
  assert.equal(domain.valorVisibleStock({ precio_tienda: 15000, costo_promedio: 12000 }, true), 12000);
});

test('consultas de tienda omiten columnas internas', () => {
  assert.doesNotMatch(domain.columnasUnidades(false), /costo_remision/);
  assert.doesNotMatch(domain.columnasStock(false), /costo_promedio/);
  assert.match(domain.columnasUnidades(true), /costo_remision/);
  assert.match(domain.columnasStock(true), /costo_promedio/);
});
