(function (global) {
  'use strict';

  const TIPOS_PERMITIDOS = new Set(['image/jpeg', 'image/png', 'image/webp']);
  const MAX_BYTES = 5 * 1024 * 1024;

  function permisosCatalogo(rol) {
    const puedeEditarProducto = rol === 'gerencia' || rol === 'auditoria';
    const puedeGestionarFoto = puedeEditarProducto || rol === 'admin_tienda';
    return { puedeEditarProducto, puedeGestionarFoto };
  }

  function columnasProductos(rol) {
    if (!permisosCatalogo(rol).puedeEditarProducto) {
      return 'id,codigo,nombre,categoria,tipo,foto_url,activo';
    }
    return 'id,codigo,nombre,categoria,tipo,precio_guia,activo,created_at,foto_url,margen_tipo,margen_valor';
  }

  function validarArchivo(archivo) {
    if (!archivo) return 'Selecciona una foto.';
    if (!TIPOS_PERMITIDOS.has(archivo.type)) return 'La foto debe ser JPG, PNG o WEBP.';
    if (!Number.isFinite(Number(archivo.size)) || Number(archivo.size) <= 0) return 'La foto está vacía.';
    if (Number(archivo.size) > MAX_BYTES) return 'La foto no puede pesar más de 5 MB.';
    return '';
  }

  function limpiarCodigo(codigo) {
    return String(codigo || 'producto')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'producto';
  }

  function extensionArchivo(archivo) {
    const extensionNombre = String(archivo?.name || '').split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'webp'].includes(extensionNombre)) return extensionNombre;
    return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[archivo?.type] || 'jpg';
  }

  function crearRutaFoto(codigoProducto, archivo, ahora = Date.now()) {
    return `${limpiarCodigo(codigoProducto)}_${Number(ahora)}.${extensionArchivo(archivo)}`;
  }

  async function subirFotoSegura({ sb, productoId, codigoProducto, archivo, ahora = Date.now() }) {
    const errorArchivo = validarArchivo(archivo);
    if (errorArchivo) throw new Error(errorArchivo);
    if (!productoId) throw new Error('No se identificó el producto.');

    const ruta = crearRutaFoto(codigoProducto, archivo, ahora);
    const bucket = sb.storage.from('productos-fotos');
    const { error: errorSubida } = await bucket.upload(ruta, archivo, {
      cacheControl: '31536000',
      contentType: archivo.type,
      upsert: false,
    });
    if (errorSubida) throw errorSubida;

    const { data: urlData } = bucket.getPublicUrl(ruta);
    const fotoUrl = urlData?.publicUrl;
    const { error: errorActualizacion } = await sb.rpc('actualizar_foto_producto_segura', {
      p_producto_id: productoId,
      p_foto_url: fotoUrl,
    });

    if (errorActualizacion) {
      if (typeof bucket.remove === 'function') {
        try { await bucket.remove([ruta]); } catch (_) { /* limpieza de mejor esfuerzo */ }
      }
      throw errorActualizacion;
    }

    return fotoUrl;
  }

  global.CreditekProductoFoto = Object.freeze({
    permisosCatalogo,
    columnasProductos,
    validarArchivo,
    crearRutaFoto,
    subirFotoSegura,
  });
})(typeof window !== 'undefined' ? window : globalThis);
