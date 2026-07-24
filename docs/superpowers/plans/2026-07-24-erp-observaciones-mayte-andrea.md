# ERP Creditek — Plan de corrección de observaciones Mayte y Andrea

**Fecha:** 24 de julio de 2026
**Alcance:** ERP web, base de datos Supabase y despliegue Cloudflare.
**Fuera de alcance:** Sofía, sus conversaciones, prompts y automatizaciones.

## Principios de ejecución

- Conservar operativa la versión actual mientras se trabaja en una rama.
- No publicar una migración ni una versión web sin pruebas previas.
- No mostrar a tiendas el costo interno de Creditek.
- No alterar históricos financieros sin conciliación y una ruta reversible.
- Separar fallos reales, mejoras de uso y comportamientos correctos que solo requieren explicación.

## Estado auditado

- Las remisiones ya muestran proveedor, factura, datos legales, logo y trazabilidad sin exponer costos internos.
- El inventario actual ya filtra por estado en su tabla, pero el selector general de tienda no comunica el cambio a las páginas y el resumen no respeta siempre la tienda elegida.
- El catálogo de tienda ya calcula “Mi costo”, pero la carga de foto está restringida a central y hay una llamada inexistente después de guardar.
- La bodega filtra la factura solo para unidades serializadas; los productos por cantidad requieren manejo por lote para que el despacho respete la factura seleccionada.
- Las ventas no ofrecen detalle al abrir una factura.
- Los abonos afectan el saldo antes de la verificación de Oscar, aunque la tabla ya dispone de campos de verificación.
- El mensaje de cierre de caja detalla demasiado los accesorios y no incluye la utilidad.
- Traslados pendientes de aceptación son un comportamiento correcto; falta hacerlo más comprensible.
- Las compras por proveedor existen, pero su acceso no es suficientemente evidente.

## Bloque 1 — Contexto de tienda e inventario seguro

**Archivos**

- Modificar `creditek/erp/sidebar.js`
- Crear `creditek/erp/inventario-domain.js`
- Modificar `creditek/erp/inventario.html`
- Crear `tests/erp/inventario-domain.test.mjs`

**Pasos**

1. Escribir pruebas que comprueben:
   - el resumen solo cuenta existencias disponibles;
   - el resumen respeta la tienda seleccionada;
   - central ve costo interno y tienda ve precio asignado;
   - existencias por cantidad usan `precio_tienda` para tiendas.
2. Crear funciones puras reutilizables para filtrar y resumir inventario.
3. Hacer que el selector del menú emita el evento `creditek:tienda-cambiada`.
4. Hacer que inventario escuche el evento, aplique el mismo filtro a resumen y tabla y actualice sin recargar.
5. Corregir encabezados y valores de costo según rol.
6. Ejecutar pruebas unitarias y construcción pública.

## Bloque 2 — Catálogo por rol y fotografías

**Archivos**

- Modificar `creditek/erp/catalogo.html`
- Crear `creditek/erp/producto-foto.js`
- Modificar `creditek/erp/remisiones.html`
- Crear `creditek/erp/migrations/20260724_producto_foto_tienda_segura.sql`
- Crear `tests/erp/producto-foto.test.mjs`

**Pasos**

1. Probar los permisos de presentación: margen y costo interno solo central; “Mi costo” para tienda.
2. Permitir a una tienda agregar o cambiar la foto de un producto, incluso durante la recepción de una remisión, sin habilitarle campos financieros centrales.
3. Reemplazar la llamada inexistente `cargarCategoriasExistentes()` por la carga real.
4. Mantener la creación central de productos sin exigir foto, porque la tienda puede completarla.
5. Validar carga, edición y recarga del catálogo en ambos roles.

## Bloque 3 — Inventario por factura/lote en bodega

**Archivos**

- Crear `creditek/erp/migrations/20260724_inventario_lotes_factura.sql`
- Modificar `creditek/erp/bodega-central.html`
- Crear `creditek/erp/tests/smoke_test_inventario_lotes.sql`

**Pasos**

1. Construir disponibilidad por factura y producto a partir de entradas de compra menos salidas trazadas.
2. Crear una función transaccional de despacho que reciba la factura/lote seleccionada y bloquee saldo para evitar doble despacho.
3. Conservar el comportamiento actual para serializados y completar el equivalente para productos por cantidad.
4. Probar en transacción con `ROLLBACK`: una compra dividida, selección de una factura, despacho parcial, intento superior al saldo y concurrencia.
5. Aplicar la migración solo después de pasar todas las pruebas y verificar nuevamente cantidades totales.

## Bloque 4 — Detalle de ventas

**Archivos**

- Modificar `creditek/erp/ventas.html`
- Crear `tests/erp/ventas-detalle.test.mjs`

**Pasos**

1. Agregar apertura por fila y por número de factura.
2. Consultar artículos, cantidades, precios unitarios y totales.
3. Mostrar un modal accesible sin exponer utilidad o costo interno cuando el rol no corresponda.
4. Probar ventas con celulares, accesorios y factura mixta.

## Bloque 5 — Abonos pendientes de verificación

**Archivos**

- Crear `creditek/erp/migrations/20260724_abonos_verificacion_prepare.sql`
- Crear `creditek/erp/migrations/20260724_abonos_verificacion_enforce.sql`
- Modificar `creditek/erp/cuenta-corriente.html`
- Crear `creditek/erp/tests/smoke_test_abonos_verificacion.sql`

**Pasos**

1. Crear funciones transaccionales separadas para registrar y verificar.
2. Registrar el soporte como “Pendiente” sin afectar todavía el saldo.
3. Al verificar Oscar, aplicar exactamente un movimiento a cuenta corriente y guardar quién/cuándo verificó.
4. Impedir doble aplicación mediante restricción o comprobación atómica.
5. Mostrar por defecto los últimos diez días con opción de ampliar.
6. Conciliar abonos históricos antes de aplicar la migración en producción.

## Bloque 6 — Cierre de caja para WhatsApp

**Archivos**

- Crear `creditek/erp/caja-domain.js`
- Modificar `creditek/erp/caja.html`
- Crear `tests/erp/caja-domain.test.mjs`

**Pasos**

1. Mantener detalle individual de celulares y créditos.
2. Agrupar accesorios por producto y cantidad.
3. Agregar utilidad total al final según los movimientos registrados.
4. Probar longitud del mensaje y totales con cierres mixtos.

## Bloque 7 — Claridad de traslados y compras

**Archivos**

- Modificar `creditek/erp/traslados.html`
- Modificar `creditek/erp/proveedores.html`

**Pasos**

1. Explicar que “En traslado” permanece hasta que la tienda destino acepta.
2. Hacer visible el acceso al historial de compras/facturas por proveedor.
3. Verificar ambos recorridos con perfiles central y tienda.

## Bloque 8 — Verificación y publicación

1. Ejecutar pruebas unitarias, pruebas SQL transaccionales y construcción pública.
2. Probar central, una tienda origen y una tienda destino.
3. Verificar que Sofía y sus archivos no cambiaron.
4. Subir primero una versión candidata de Cloudflare sin activarla.
5. Validar las rutas principales y después activar la versión.
6. Documentar en una matriz cada observación como corregida, comportamiento esperado o pendiente justificado.
