-- =============================================================================
-- SMOKE TEST · Bodega Central + Compra a Proveedor + Margen automático
-- Documento: smoke_test_bodega_central_v1.sql · 21 julio 2026
-- =============================================================================
-- Ejecución: como service_role via MCP o psql.
-- Aislamiento: todo dentro de un DO block que RAISE EXCEPTION al final
--              para forzar ROLLBACK y no ensuciar la base.
-- Autenticación simulada: usa el perfil gerencia real (id fijo abajo) vía
--                          set_config('request.jwt.claim.sub', ...).
-- =============================================================================

DO $smoke$
DECLARE
  -- ---------- FIJAS ----------
  v_gerencia_id uuid := '6de0ad26-64af-4966-8cd9-d468880af627';
  v_tienda_destino text := 'CK-11';  -- Creditel Covenas (propia, activa)
  v_prod_cantidad_id uuid := '244f288b-d268-426f-a5d9-11c13eb31c44'; -- Hidrogel
  v_prod_serial_id uuid := '429aabbe-56af-49c5-8526-7d188c5c16e2';   -- Motorola Moto E14

  -- ---------- VARIABLES ----------
  v_prov_id uuid;
  v_res jsonb;
  v_factura_a uuid;
  v_factura_b uuid;
  v_remision_id uuid;
  v_ri_cantidad uuid;
  v_ri_serial uuid;
  v_stock_central int;
  v_stock_ck11 int;
  v_unidades_ct_central int;
  v_unidades_ct_traslado int;
  v_unidades_ct_ck11 int;
  v_ajustes_ct int;
  v_alerta_hidrogel record;
  v_alerta_motorola record;
  v_utilidad record;
  v_esperado_facturado numeric;
  v_esperado_costo numeric;
  v_esperado_utilidad numeric;
BEGIN
  -- ============================================================
  -- SETUP: simular sesión de usuario gerencia
  -- ============================================================
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.sub', v_gerencia_id::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_gerencia_id::text, 'role', 'authenticated')::text, true);

  IF NOT es_central() THEN
    RAISE EXCEPTION 'SMOKE_FAIL setup: es_central() debería ser true';
  END IF;

  -- ============================================================
  -- STEP 0: crear proveedor de prueba
  -- ============================================================
  INSERT INTO proveedores (nombre, nit, telefono, contacto, activo)
  VALUES ('SMOKE TEST PROV', 'SMOKE-NIT-0001', '3000000000', 'Test Automatizado', true)
  RETURNING id INTO v_prov_id;

  -- ============================================================
  -- STEP A: registrar compra tipo CANTIDAD (Hidrogel x 10 @ $1000)
  -- ============================================================
  v_res := registrar_compra_proveedor(
    v_prov_id, 'FT-SMOKE-A', CURRENT_DATE,
    jsonb_build_array(
      jsonb_build_object('producto_id', v_prod_cantidad_id, 'cantidad', 10, 'costo_unitario', 1000)
    ),
    NULL, 'compra smoke A'
  );
  v_factura_a := (v_res->>'factura_id')::uuid;

  IF (v_res->>'total')::numeric <> 10000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL A.1: total esperado 10000, obtenido %', v_res->>'total';
  END IF;

  SELECT cantidad INTO v_stock_central FROM stock_cantidad
    WHERE producto_id = v_prod_cantidad_id AND tienda_codigo = 'CENTRAL';
  IF v_stock_central <> 10 THEN
    RAISE EXCEPTION 'SMOKE_FAIL A.2: stock CENTRAL Hidrogel esperado 10, obtenido %', v_stock_central;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM movimientos
                 WHERE tipo='compra_entrada' AND tienda_codigo='CENTRAL'
                   AND producto_id=v_prod_cantidad_id AND cantidad=10) THEN
    RAISE EXCEPTION 'SMOKE_FAIL A.3: falta movimiento compra_entrada Hidrogel';
  END IF;

  -- ============================================================
  -- STEP B: registrar compra tipo SERIALIZADO (Motorola x 3 @ $500000, SIN IMEIs)
  -- ============================================================
  v_res := registrar_compra_proveedor(
    v_prov_id, 'FT-SMOKE-B', CURRENT_DATE,
    jsonb_build_array(
      jsonb_build_object('producto_id', v_prod_serial_id, 'cantidad', 3, 'costo_unitario', 500000)
    ),
    NULL, 'compra smoke B'
  );
  v_factura_b := (v_res->>'factura_id')::uuid;

  IF (v_res->>'total')::numeric <> 1500000 THEN
    RAISE EXCEPTION 'SMOKE_FAIL B.1: total esperado 1500000, obtenido %', v_res->>'total';
  END IF;

  SELECT count(*) INTO v_unidades_ct_central FROM unidades
    WHERE producto_id = v_prod_serial_id
      AND tienda_actual = 'CENTRAL'
      AND estado = 'disponible'
      AND imei IS NULL
      AND factura_proveedor_id = v_factura_b;
  IF v_unidades_ct_central <> 3 THEN
    RAISE EXCEPTION 'SMOKE_FAIL B.2: unidades CENTRAL Motorola esperado 3, obtenido %', v_unidades_ct_central;
  END IF;

  -- Verificar costo_remision correcto (debe ser el costo, no el precio)
  IF NOT EXISTS (SELECT 1 FROM unidades
                 WHERE factura_proveedor_id = v_factura_b
                   AND costo_remision = 500000) THEN
    RAISE EXCEPTION 'SMOKE_FAIL B.3: costo_remision no es 500000';
  END IF;

  -- ============================================================
  -- STEP C: despachar remisión desde CENTRAL a CK-11
  --   6 Hidrogel @ $1500 remisión + 2 Motorola @ $650000 remisión
  -- ============================================================
  v_res := despachar_remision_desde_central(
    v_tienda_destino,
    jsonb_build_array(
      jsonb_build_object('producto_id', v_prod_cantidad_id, 'cantidad', 6, 'precio_remision', 1500),
      jsonb_build_object('producto_id', v_prod_serial_id,   'cantidad', 2, 'precio_remision', 650000)
    ),
    'despacho smoke C'
  );
  v_remision_id := (v_res->>'remision_id')::uuid;

  -- CENTRAL: Hidrogel bajó de 10 a 4
  SELECT cantidad INTO v_stock_central FROM stock_cantidad
    WHERE producto_id = v_prod_cantidad_id AND tienda_codigo = 'CENTRAL';
  IF v_stock_central <> 4 THEN
    RAISE EXCEPTION 'SMOKE_FAIL C.1: stock CENTRAL Hidrogel post-despacho esperado 4, obtenido %', v_stock_central;
  END IF;

  -- CENTRAL: 2 unidades Motorola pasaron a en_traslado (todavía tienda_actual=CENTRAL)
  SELECT count(*) INTO v_unidades_ct_traslado FROM unidades
    WHERE producto_id = v_prod_serial_id
      AND tienda_actual = 'CENTRAL'
      AND estado = 'en_traslado'
      AND imei IS NULL;
  IF v_unidades_ct_traslado <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL C.2: unidades Motorola en_traslado esperado 2, obtenido %', v_unidades_ct_traslado;
  END IF;

  -- CENTRAL: quedan 1 unidad Motorola disponible
  SELECT count(*) INTO v_unidades_ct_central FROM unidades
    WHERE producto_id = v_prod_serial_id
      AND tienda_actual = 'CENTRAL'
      AND estado = 'disponible'
      AND imei IS NULL;
  IF v_unidades_ct_central <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL C.3: unidades Motorola disponibles restantes esperado 1, obtenido %', v_unidades_ct_central;
  END IF;

  -- Verificar remision_margenes: 1 fila Hidrogel (cantidad=6) + 2 filas Motorola (cantidad=1 c/u)
  SELECT id INTO v_ri_cantidad FROM remision_items
    WHERE remision_id = v_remision_id AND producto_id = v_prod_cantidad_id;
  SELECT id INTO v_ri_serial FROM remision_items
    WHERE remision_id = v_remision_id AND producto_id = v_prod_serial_id;

  IF NOT EXISTS (SELECT 1 FROM remision_margenes
                 WHERE remision_item_id = v_ri_cantidad
                   AND unidad_id IS NULL
                   AND cantidad = 6
                   AND costo_oscar = 1000) THEN
    RAISE EXCEPTION 'SMOKE_FAIL C.4: remision_margenes Hidrogel no coincide';
  END IF;

  IF (SELECT count(*) FROM remision_margenes
      WHERE remision_item_id = v_ri_serial
        AND unidad_id IS NOT NULL
        AND cantidad = 1
        AND costo_oscar = 500000
        AND factura_proveedor_id = v_factura_b) <> 2 THEN
    RAISE EXCEPTION 'SMOKE_FAIL C.5: esperaba 2 filas remision_margenes por unidad Motorola con factura B';
  END IF;

  -- Estado de remisión
  IF NOT EXISTS (SELECT 1 FROM remisiones WHERE id=v_remision_id AND estado='despachada' AND consecutivo IS NOT NULL) THEN
    RAISE EXCEPTION 'SMOKE_FAIL C.6: remision no quedó despachada con consecutivo';
  END IF;

  -- ============================================================
  -- STEP D: confirmar recepción parcial en CK-11
  --   - Hidrogel: cantidad_recibida=6 (todo llegó)
  --   - Motorola: 1 IMEI (SMOKE-IMEI-001) — solo 1 de las 2 despachadas
  --   → Debe generar ajuste pendiente por 1 unidad faltante
  -- ============================================================
  v_res := confirmar_recepcion_remision(
    v_remision_id,
    jsonb_build_array(
      jsonb_build_object('remision_item_id', v_ri_cantidad, 'cantidad_recibida', 6),
      jsonb_build_object('remision_item_id', v_ri_serial,   'imeis', jsonb_build_array('SMOKE-IMEI-001'))
    )
  );

  -- Hidrogel llegó a CK-11: stock 6, costo_promedio=1500 (precio_remision, patrón cantidad)
  SELECT cantidad INTO v_stock_ck11 FROM stock_cantidad
    WHERE producto_id = v_prod_cantidad_id AND tienda_codigo = 'CK-11';
  IF v_stock_ck11 <> 6 THEN
    RAISE EXCEPTION 'SMOKE_FAIL D.1: stock CK-11 Hidrogel esperado 6, obtenido %', COALESCE(v_stock_ck11::text,'null');
  END IF;

  -- Motorola: 1 unidad con IMEI='SMOKE-IMEI-001', disponible en CK-11
  SELECT count(*) INTO v_unidades_ct_ck11 FROM unidades
    WHERE producto_id = v_prod_serial_id
      AND tienda_actual = 'CK-11'
      AND estado = 'disponible'
      AND imei = 'SMOKE-IMEI-001';
  IF v_unidades_ct_ck11 <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL D.2: esperaba 1 unidad Motorola con IMEI SMOKE-IMEI-001 en CK-11, obtenido %', v_unidades_ct_ck11;
  END IF;

  -- 1 unidad Motorola quedó en_traslado (la faltante)
  SELECT count(*) INTO v_unidades_ct_traslado FROM unidades
    WHERE producto_id = v_prod_serial_id
      AND estado = 'en_traslado'
      AND remision_item_id = v_ri_serial;
  IF v_unidades_ct_traslado <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL D.3: esperaba 1 unidad Motorola aún en_traslado, obtenido %', v_unidades_ct_traslado;
  END IF;

  -- Ajuste pendiente por 1 faltante
  SELECT count(*) INTO v_ajustes_ct FROM ajustes_inventario
    WHERE tienda_codigo = 'CK-11'
      AND producto_id = v_prod_serial_id
      AND diferencia = -1
      AND estado = 'pendiente'
      AND motivo LIKE '%Faltantes al recibir remision%';
  IF v_ajustes_ct <> 1 THEN
    RAISE EXCEPTION 'SMOKE_FAIL D.4: esperaba 1 ajuste pendiente, obtenido %', v_ajustes_ct;
  END IF;

  -- Remisión pasó a recibida
  IF NOT EXISTS (SELECT 1 FROM remisiones WHERE id=v_remision_id AND estado='recibida') THEN
    RAISE EXCEPTION 'SMOKE_FAIL D.5: remisión no quedó en estado recibida';
  END IF;

  -- Cuenta corriente: cargo total = 6*1500 + 1*650000 = 9000 + 650000 = 659000
  IF NOT EXISTS (SELECT 1 FROM cuenta_corriente
                 WHERE tienda_codigo = 'CK-11'
                   AND tipo = 'cargo'
                   AND monto = 659000
                   AND referencia_id = v_remision_id::text) THEN
    RAISE EXCEPTION 'SMOKE_FAIL D.6: cuenta_corriente no tiene el cargo por 659000';
  END IF;

  -- ============================================================
  -- STEP E: verificar vistas
  -- ============================================================
  -- alerta_bodega_central: Hidrogel con stock 4 (descuadrado), Motorola con 1 disponible + 1 en_traslado = 2 (descuadrado)
  SELECT * INTO v_alerta_hidrogel FROM alerta_bodega_central WHERE producto_id = v_prod_cantidad_id;
  IF v_alerta_hidrogel.stock_actual_central <> 4 OR NOT v_alerta_hidrogel.descuadrado THEN
    RAISE EXCEPTION 'SMOKE_FAIL E.1: alerta Hidrogel: stock=% descuadrado=%',
      v_alerta_hidrogel.stock_actual_central, v_alerta_hidrogel.descuadrado;
  END IF;

  SELECT * INTO v_alerta_motorola FROM alerta_bodega_central WHERE producto_id = v_prod_serial_id;
  -- 1 disponible + 1 en_traslado (ambos con imei IS NULL en CENTRAL) = 2
  IF v_alerta_motorola.stock_actual_central <> 2 OR NOT v_alerta_motorola.descuadrado THEN
    RAISE EXCEPTION 'SMOKE_FAIL E.2: alerta Motorola: stock=% descuadrado=%',
      v_alerta_motorola.stock_actual_central, v_alerta_motorola.descuadrado;
  END IF;

  -- utilidad_creditek_por_periodo: mes actual
  --   Hidrogel: 6 * 1500 = 9000 facturado ; 6 * 1000 = 6000 costo ; utilidad 3000
  --   Motorola: 2 * 650000 = 1300000 facturado ; 2 * 500000 = 1000000 costo ; utilidad 300000
  --   Total: 1309000 facturado ; 1006000 costo ; 303000 utilidad
  SELECT * INTO v_utilidad FROM utilidad_creditek_por_periodo
    WHERE periodo = date_trunc('month', (now() AT TIME ZONE 'America/Bogota'))::date;

  v_esperado_facturado := 6*1500 + 2*650000;
  v_esperado_costo := 6*1000 + 2*500000;
  v_esperado_utilidad := v_esperado_facturado - v_esperado_costo;

  IF v_utilidad.total_facturado_tiendas <> v_esperado_facturado THEN
    RAISE EXCEPTION 'SMOKE_FAIL E.3: facturado esperado %, obtenido %',
      v_esperado_facturado, v_utilidad.total_facturado_tiendas;
  END IF;
  IF v_utilidad.total_costo_real <> v_esperado_costo THEN
    RAISE EXCEPTION 'SMOKE_FAIL E.4: costo esperado %, obtenido %',
      v_esperado_costo, v_utilidad.total_costo_real;
  END IF;
  IF v_utilidad.utilidad_creditek <> v_esperado_utilidad THEN
    RAISE EXCEPTION 'SMOKE_FAIL E.5: utilidad esperada %, obtenida %',
      v_esperado_utilidad, v_utilidad.utilidad_creditek;
  END IF;

  -- ============================================================
  -- TODO OK → forzar rollback vía RAISE con marcador de éxito
  -- ============================================================
  RAISE EXCEPTION 'SMOKE_TEST_OK v1: 5/5 pasos superados. Cantidad OK · Serializado OK · Despacho FIFO OK · Recepción parcial + IMEI + ajuste OK · Vistas OK (facturado=% costo=% utilidad=%)',
    v_esperado_facturado, v_esperado_costo, v_esperado_utilidad;
END;
$smoke$;
