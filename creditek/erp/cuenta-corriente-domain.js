(function (global) {
  'use strict';

  function numero(valor) {
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : 0;
  }

  function columnasMovimientos() {
    return [
      'id',
      'tienda_codigo',
      'tipo',
      'concepto',
      'monto',
      'referencia_tipo',
      'referencia_id',
      'usuario',
      'nota',
      'created_at',
    ].join(',');
  }

  function columnasAbonos() {
    return [
      'id',
      'tienda_codigo',
      'monto',
      'fecha',
      'soporte_path',
      'registrado_por',
      'verificado_por',
      'verificado_at',
      'created_at',
    ].join(',');
  }

  function calcularResumenPorTienda(movimientos) {
    const mapa = {};
    (movimientos || []).forEach(movimiento => {
      if (!mapa[movimiento.tienda_codigo]) {
        mapa[movimiento.tienda_codigo] = { saldo: 0, ultimoCargo: null, ultimoAbono: null };
      }
      const resumen = mapa[movimiento.tienda_codigo];
      if (movimiento.tipo === 'cargo') {
        resumen.saldo += numero(movimiento.monto);
        resumen.ultimoCargo = movimiento;
      } else if (movimiento.tipo === 'abono') {
        resumen.saldo -= numero(movimiento.monto);
        resumen.ultimoAbono = movimiento;
      }
    });
    return mapa;
  }

  function prepararHistorial({ movimientos, dias = 10, ahora = new Date() }) {
    let saldo = 0;
    const ascendentes = [...(movimientos || [])]
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(movimiento => {
        if (movimiento.tipo === 'cargo') saldo += numero(movimiento.monto);
        else if (movimiento.tipo === 'abono') saldo -= numero(movimiento.monto);
        return { ...movimiento, saldoAcumulado: saldo };
      });

    let visibles = ascendentes;
    if (Number.isFinite(Number(dias)) && Number(dias) > 0) {
      const corte = new Date(ahora);
      corte.setDate(corte.getDate() - Number(dias));
      visibles = ascendentes.filter(movimiento => new Date(movimiento.created_at) >= corte);
    }

    return {
      saldoActual: saldo,
      filas: visibles.reverse(),
    };
  }

  function estadoAbono(abono, movimientoExiste) {
    if (abono?.verificado_at) return 'verificado';
    return movimientoExiste ? 'legacy_pendiente' : 'pendiente';
  }

  global.CreditekCuentaCorrienteDomain = Object.freeze({
    columnasMovimientos,
    columnasAbonos,
    calcularResumenPorTienda,
    prepararHistorial,
    estadoAbono,
  });
})(typeof window !== 'undefined' ? window : globalThis);
