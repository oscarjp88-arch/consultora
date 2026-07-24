(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CreditekBodegaDomain = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function consolidarDisponibilidad({ productos, unidades, lotes, facturaId }) {
    const porProducto = new Map(
      (productos || []).map(producto => [
        producto.id,
        {
          ...producto,
          disponible: 0,
          precio_tienda: null,
          precios_varian: false,
          facturas: [],
        },
      ]),
    );

    function agregar(registro, cantidad) {
      if (facturaId && registro.factura_proveedor_id !== facturaId) return;
      const producto = porProducto.get(registro.producto_id);
      if (!producto) return;

      producto.disponible += Number(cantidad || 0);
      if (registro.factura_proveedor_id && !producto.facturas.includes(registro.factura_proveedor_id)) {
        producto.facturas.push(registro.factura_proveedor_id);
      }
      if (producto.precio_tienda == null) {
        producto.precio_tienda = registro.precio_tienda;
      } else if (Number(producto.precio_tienda) !== Number(registro.precio_tienda)) {
        producto.precios_varian = true;
      }
    }

    (unidades || []).forEach(unidad => agregar(unidad, 1));
    (lotes || []).forEach(lote => agregar(lote, lote.cantidad));

    return [...porProducto.values()]
      .filter(producto => producto.disponible > 0)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  }

  function crearItemPayload(item, facturaId) {
    const payload = {
      producto_id: item.producto_id,
      cantidad: item.cantidad,
    };
    if (facturaId) payload.factura_proveedor_id = facturaId;
    if (item.precio_override_active) payload.precio_override = item.precio_remision;
    return payload;
  }

  return {
    consolidarDisponibilidad,
    crearItemPayload,
  };
});
