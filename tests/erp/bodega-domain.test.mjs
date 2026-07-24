import test from 'node:test';
import assert from 'node:assert/strict';
import bodega from '../../creditek/erp/bodega-domain.js';

const productos = [
  { id: 'cel', nombre: 'Celular', categoria: 'Celulares', tipo: 'serializado' },
  { id: 'acc', nombre: 'Silicona', categoria: 'Accesorios', tipo: 'cantidad' },
];

test('el filtro de factura incluye inventario serializado y por cantidad', () => {
  const resultado = bodega.consolidarDisponibilidad({
    productos,
    unidades: [
      { producto_id: 'cel', factura_proveedor_id: 'f1', precio_tienda: 200 },
      { producto_id: 'cel', factura_proveedor_id: 'f2', precio_tienda: 220 },
    ],
    lotes: [
      { producto_id: 'acc', factura_proveedor_id: 'f1', cantidad: 3, precio_tienda: 20 },
      { producto_id: 'acc', factura_proveedor_id: 'f2', cantidad: 5, precio_tienda: 25 },
    ],
    facturaId: 'f1',
  });

  assert.deepEqual(
    resultado.map(p => [p.id, p.disponible, p.precio_tienda]),
    [['cel', 1, 200], ['acc', 3, 20]],
  );
});

test('sin filtro suma los lotes disponibles sin perder su trazabilidad', () => {
  const resultado = bodega.consolidarDisponibilidad({
    productos,
    unidades: [],
    lotes: [
      { producto_id: 'acc', factura_proveedor_id: 'f1', cantidad: 3, precio_tienda: 20 },
      { producto_id: 'acc', factura_proveedor_id: 'f2', cantidad: 5, precio_tienda: 25 },
    ],
    facturaId: null,
  });

  assert.equal(resultado[0].disponible, 8);
  assert.equal(resultado[0].precios_varian, true);
  assert.deepEqual(resultado[0].facturas, ['f1', 'f2']);
});

test('el despacho envía la factura elegida al control transaccional', () => {
  assert.deepEqual(
    bodega.crearItemPayload(
      { producto_id: 'acc', cantidad: 2, precio_override_active: false },
      'f1',
    ),
    { producto_id: 'acc', cantidad: 2, factura_proveedor_id: 'f1' },
  );
});
