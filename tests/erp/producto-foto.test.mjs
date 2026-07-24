import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '../..');
const source = await readFile(path.join(root, 'creditek/erp/producto-foto.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const fotos = context.window.CreditekProductoFoto;

test('admin de tienda solo puede gestionar fotografías', () => {
  assert.deepEqual(
    { ...fotos.permisosCatalogo('admin_tienda') },
    { puedeEditarProducto: false, puedeGestionarFoto: true }
  );
  assert.deepEqual(
    { ...fotos.permisosCatalogo('gerencia') },
    { puedeEditarProducto: true, puedeGestionarFoto: true }
  );
  assert.deepEqual(
    { ...fotos.permisosCatalogo('asesor') },
    { puedeEditarProducto: false, puedeGestionarFoto: false }
  );
});

test('consulta de tienda omite margen y precio guía', () => {
  assert.doesNotMatch(fotos.columnasProductos('admin_tienda'), /margen_/);
  assert.doesNotMatch(fotos.columnasProductos('admin_tienda'), /precio_guia/);
  assert.match(fotos.columnasProductos('gerencia'), /margen_tipo/);
});

test('valida tipo y tamaño de imagen', () => {
  assert.equal(fotos.validarArchivo({ type: 'image/jpeg', size: 1024 }), '');
  assert.match(fotos.validarArchivo({ type: 'application/pdf', size: 1024 }), /JPG, PNG o WEBP/);
  assert.match(fotos.validarArchivo({ type: 'image/png', size: 6 * 1024 * 1024 }), /5 MB/);
});

test('genera una ruta segura y estable', () => {
  assert.equal(
    fotos.crearRutaFoto('SAM A/17', { name: 'foto.webp' }, 1720000000000),
    'sam-a-17_1720000000000.webp'
  );
});

test('sube la foto y actualiza únicamente por RPC segura', async () => {
  const llamadas = [];
  const storage = {
    upload: async (ruta, archivo) => {
      llamadas.push(['upload', ruta, archivo.name]);
      return { error: null };
    },
    getPublicUrl: ruta => ({
      data: { publicUrl: `https://jfkmiyvcdfbsbwchyvol.supabase.co/storage/v1/object/public/productos-fotos/${ruta}` },
    }),
  };
  const sb = {
    storage: { from: bucket => {
      assert.equal(bucket, 'productos-fotos');
      return storage;
    } },
    rpc: async (nombre, payload) => {
      llamadas.push(['rpc', nombre, payload]);
      return { data: { foto_url: payload.p_foto_url }, error: null };
    },
  };

  const resultado = await fotos.subirFotoSegura({
    sb,
    productoId: 'producto-1',
    codigoProducto: 'SAM-A17',
    archivo: { name: 'frente.jpg', type: 'image/jpeg', size: 2048 },
    ahora: 1720000000000,
  });

  assert.equal(llamadas[0][0], 'upload');
  assert.equal(llamadas[1][1], 'actualizar_foto_producto_segura');
  assert.equal(llamadas[1][2].p_producto_id, 'producto-1');
  assert.match(resultado, /productos-fotos\/sam-a17_1720000000000\.jpg$/);
});
