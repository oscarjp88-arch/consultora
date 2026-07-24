import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const source = await readFile(path.join(root, 'creditek/erp/cuenta-corriente-domain.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const cuenta = context.window.CreditekCuentaCorrienteDomain;

const movimientos = [
  { id: 'c1', tienda_codigo: 'CK-02', tipo: 'cargo', monto: 1000000, created_at: '2026-06-01T12:00:00Z' },
  { id: 'a1', tienda_codigo: 'CK-02', tipo: 'abono', monto: 200000, created_at: '2026-07-20T12:00:00Z' },
  { id: 'c2', tienda_codigo: 'CK-02', tipo: 'cargo', monto: 50000, created_at: '2026-07-23T12:00:00Z' },
];

test('un abono pendiente sin movimiento no reduce el saldo', () => {
  const resumen = cuenta.calcularResumenPorTienda(movimientos);
  assert.equal(resumen['CK-02'].saldo, 850000);
  assert.equal(cuenta.estadoAbono({ verificado_at: null }, false), 'pendiente');
});

test('un abono aplicado antes del control se identifica sin duplicarlo', () => {
  assert.equal(cuenta.estadoAbono({ verificado_at: null }, true), 'legacy_pendiente');
  assert.equal(cuenta.estadoAbono({ verificado_at: '2026-07-24T10:00:00Z' }, true), 'verificado');
});

test('historial de diez días conserva el saldo calculado con todo el histórico', () => {
  const historial = cuenta.prepararHistorial({
    movimientos,
    dias: 10,
    ahora: new Date('2026-07-24T12:00:00Z'),
  });
  assert.equal(historial.saldoActual, 850000);
  assert.equal(historial.filas.length, 2);
  assert.equal(historial.filas[0].saldoAcumulado, 850000);
});

test('consultas financieras no usan comodines', () => {
  assert.doesNotMatch(cuenta.columnasMovimientos(), /\*/);
  assert.doesNotMatch(cuenta.columnasAbonos(), /\*/);
  assert.match(cuenta.columnasAbonos(), /verificado_at/);
});
