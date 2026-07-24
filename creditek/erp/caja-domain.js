(function (global) {
  'use strict';

  function numero(valor) {
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : 0;
  }

  function relacionUnica(valor) {
    return Array.isArray(valor) ? (valor[0] || null) : (valor || null);
  }

  function columnasVentasCaja() {
    return [
      'id',
      'tipo',
      'total',
      'clientes(nombre_completo)',
      'creditos(financiera,cuota_inicial)',
      'venta_items(cantidad,precio_venta,utilidad,productos(nombre,tipo))',
    ].join(',');
  }

  function resumirVentas(ventas) {
    const telefonos = [];
    const accesoriosMap = {};
    let totalUtilidad = 0;

    (ventas || []).forEach(venta => {
      const credito = relacionUnica(venta.creditos);
      (venta.venta_items || []).forEach(item => {
        const cantidad = numero(item.cantidad);
        const precio = numero(item.precio_venta);
        totalUtilidad += numero(item.utilidad);
        if (item.productos?.tipo === 'serializado') {
          telefonos.push({
            nombre: item.productos?.nombre || 'Teléfono',
            tipo: venta.tipo,
            monto: venta.tipo === 'credito' ? numero(credito?.cuota_inicial) : precio,
          });
        } else {
          const nombre = item.productos?.nombre || 'Producto';
          if (!accesoriosMap[nombre]) accesoriosMap[nombre] = { nombre, cantidad: 0, total: 0 };
          accesoriosMap[nombre].cantidad += cantidad;
          accesoriosMap[nombre].total += cantidad * precio;
        }
      });
    });

    const accesorios = Object.values(accesoriosMap);
    const creditosDelDia = (ventas || [])
      .filter(venta => venta.tipo === 'credito')
      .map(venta => {
        const credito = relacionUnica(venta.creditos);
        const celular = (venta.venta_items || [])
          .find(item => item.productos?.tipo === 'serializado');
        return {
          cliente: venta.clientes?.nombre_completo || 'Cliente general',
          producto: celular?.productos?.nombre || '—',
          financiera: credito?.financiera || '—',
          inicial: numero(credito?.cuota_inicial),
          financiado: numero(venta.total) - numero(credito?.cuota_inicial),
        };
      });

    return {
      telefonos,
      accesorios,
      accesoriosUnidades: accesorios.reduce((total, item) => total + item.cantidad, 0),
      accesoriosTotal: accesorios.reduce((total, item) => total + item.total, 0),
      creditosDelDia,
      totalContado: (ventas || [])
        .filter(venta => venta.tipo === 'contado')
        .reduce((total, venta) => total + numero(venta.total), 0),
      totalIniciales: creditosDelDia.reduce((total, credito) => total + credito.inicial, 0),
      totalUtilidad,
    };
  }

  function crearMensajeWhatsApp({ tiendaNombre, fechaTexto, datos, formatearMoneda }) {
    const moneda = typeof formatearMoneda === 'function'
      ? formatearMoneda
      : valor => String(numero(valor));
    let texto = `*CAJA DIARIA — ${tiendaNombre} — ${fechaTexto}*\n\n`;
    texto += '*TELÉFONOS*\n';
    texto += datos.telefonos.length
      ? datos.telefonos.map(telefono =>
          `${telefono.nombre} (${telefono.tipo}) — ${telefono.tipo === 'credito' ? 'Inicial: ' : ''}${moneda(telefono.monto)}`
        ).join('\n')
      : 'Sin ventas.';
    texto += '\n\n*ACCESORIOS*\n';
    texto += datos.accesoriosUnidades
      ? `${datos.accesoriosUnidades} unidades — ${moneda(datos.accesoriosTotal)}`
      : 'Sin ventas.';
    texto += '\n\n*CRÉDITOS*\n';
    texto += datos.creditosDelDia.length
      ? datos.creditosDelDia.map(credito =>
          `${credito.cliente} — ${credito.producto} — ${credito.financiera}\n  Inicial: ${moneda(credito.inicial)} | Financiado: ${moneda(credito.financiado)}`
        ).join('\n')
      : 'Sin créditos.';
    texto += '\n\n*GASTOS*\n';
    texto += datos.gastos.length
      ? datos.gastos.map(gasto =>
          `${gasto.conceptos_gasto?.nombre || 'Gasto'} — ${moneda(gasto.monto)}`
        ).join('\n')
      : 'Sin gastos.';
    texto += `\n\n━━━━━━━━━━━━━\nTotal contado: ${moneda(datos.totalContado)}\n`;
    texto += `Total iniciales: ${moneda(datos.totalIniciales)}\n`;
    texto += `Total gastos: -${moneda(datos.totalGastos)}\n`;
    texto += `*EFECTIVO ESPERADO: ${moneda(datos.esperado)}*\n`;
    texto += `Efectivo contado: ${moneda(datos.caja?.efectivo_contado)}\n`;
    texto += `Diferencia: ${moneda(datos.caja?.diferencia)}\n`;
    texto += `*UTILIDAD DEL DÍA: ${moneda(datos.totalUtilidad)}*`;
    return texto;
  }

  global.CreditekCajaDomain = Object.freeze({
    columnasVentasCaja,
    resumirVentas,
    crearMensajeWhatsApp,
  });
})(typeof window !== 'undefined' ? window : globalThis);
