import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const source = await readFile(path.join(root, 'creditek/erp/caja-domain.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const caja = context.window.CreditekCajaDomain;

const ventas = [
  {
    tipo: 'credito',
    total: 900000,
    clientes: { nombre_completo: 'Cliente Uno' },
    creditos: [{ financiera: 'PayJoy', cuota_inicial: 100000 }],
    venta_items: [
      { cantidad: 1, precio_venta: 900000, utilidad: 120000, productos: { nombre: 'Samsung A17', tipo: 'serializado' } },
      { cantidad: 2, precio_venta: 20000, utilidad: 10000, productos: { nombre: 'Cable USB', tipo: 'cantidad' } },
    ],
  },
  {
    tipo: 'contado',
    total: 50000,
    clientes: null,
    creditos: [],
    venta_items: [
      { cantidad: 1, precio_venta: 50000, utilidad: 15000, productos: { nombre: 'Audífonos', tipo: 'cantidad' } },
    ],
  },
];

test('resume accesorios y calcula utilidad de todas las líneas', () => {
  const resumen = caja.resumirVentas(ventas);
  assert.equal(resumen.telefonos.length, 1);
  assert.equal(resumen.accesoriosUnidades, 3);
  assert.equal(resumen.accesoriosTotal, 90000);
  assert.equal(resumen.totalUtilidad, 145000);
});

test('mensaje detalla teléfonos y créditos pero resume accesorios', () => {
  const resumen = caja.resumirVentas(ventas);
  const mensaje = caja.crearMensajeWhatsApp({
    tiendaNombre: 'CK-02',
    fechaTexto: '24/07/2026',
    datos: {
      ...resumen,
      gastos: [],
      totalGastos: 0,
      esperado: 150000,
      caja: { efectivo_contado: 150000, diferencia: 0 },
    },
    formatearMoneda: valor => `$${Number(valor)}`,
  });

  assert.match(mensaje, /Samsung A17/);
  assert.match(mensaje, /Cliente Uno/);
  assert.match(mensaje, /3 unidades.*\$90000/);
  assert.doesNotMatch(mensaje, /Cable USB|Audífonos/);
  assert.match(mensaje, /UTILIDAD DEL DÍA: \$145000/);
});

test('consulta del cierre omite costo congelado y comodines', () => {
  assert.doesNotMatch(caja.columnasVentasCaja(), /costo_congelado|\*/);
  assert.match(caja.columnasVentasCaja(), /utilidad/);
});
