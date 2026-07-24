import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const source = await readFile(path.join(root, 'creditek/erp/ventas-domain.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const ventas = context.window.CreditekVentasDomain;

test('detalle calcula subtotales sin devolver costo ni utilidad internos', () => {
  const detalle = ventas.prepararDetalle({
    venta: { id: 'v1', total: 910000, tipo: 'credito' },
    items: [
      {
        cantidad: 1,
        precio_venta: 850000,
        costo_congelado: 700000,
        utilidad: 150000,
        productos: { codigo: 'SAM-A17', nombre: 'Samsung A17' },
        unidades: { imei: '123456789' },
      },
      {
        cantidad: 2,
        precio_venta: 30000,
        costo_congelado: 15000,
        utilidad: 30000,
        productos: { codigo: 'CAB-01', nombre: 'Cable' },
      },
    ],
    credito: { financiera: 'payjoy', cuota_inicial: 100000 },
  });

  assert.equal(detalle.items[0].subtotal, 850000);
  assert.equal(detalle.items[1].subtotal, 60000);
  assert.equal(detalle.totalCalculado, 910000);
  assert.equal(detalle.items[0].imei, '123456789');
  assert.equal('costo_congelado' in detalle.items[0], false);
  assert.equal('utilidad' in detalle.items[0], false);
});

test('consultas de venta omiten costo, utilidad y comodines', () => {
  assert.doesNotMatch(ventas.columnasListaVentas(), /\*/);
  assert.doesNotMatch(ventas.columnasDetalleItems(), /costo_congelado|utilidad|\*/);
  assert.match(ventas.columnasDetalleItems(), /precio_venta/);
});

test('consulta de unidad para vender omite costo interno', () => {
  assert.doesNotMatch(ventas.columnasUnidadVenta(), /costo_remision|precio_guia|\*/);
  assert.match(ventas.columnasUnidadVenta(), /precio_tienda/);
});
