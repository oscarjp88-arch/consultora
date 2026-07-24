begin;

do $$
declare
  v_desajustes integer;
  v_entradas integer;
  v_lotes integer;
  v_funcion text;
begin
  if exists (
    select 1
    from public.stock_cantidad_lotes
    where cantidad < 0
  ) then
    raise exception 'Hay lotes con cantidad negativa';
  end if;

  select count(*)
  into v_entradas
  from public.movimientos m
  join public.productos p on p.id = m.producto_id
  where m.tipo = 'compra_entrada'
    and m.tienda_codigo = 'CENTRAL'
    and m.referencia_tipo = 'factura_proveedor'
    and p.tipo = 'cantidad';

  select count(*)
  into v_lotes
  from public.stock_cantidad_lotes;

  if v_lotes <> v_entradas then
    raise exception
      'No hay un lote por entrada: entradas %, lotes %',
      v_entradas, v_lotes;
  end if;

  select count(*)
  into v_desajustes
  from (
    select
      coalesce(sc.producto_id, l.producto_id) as producto_id,
      coalesce(sc.cantidad, 0) as stock_resumen,
      coalesce(l.cantidad, 0) as stock_lotes
    from (
      select producto_id, cantidad
      from public.stock_cantidad
      where tienda_codigo = 'CENTRAL'
    ) sc
    full join (
      select producto_id, sum(cantidad)::integer as cantidad
      from public.stock_cantidad_lotes
      where tienda_codigo = 'CENTRAL'
      group by producto_id
    ) l using (producto_id)
  ) x
  where x.stock_resumen <> x.stock_lotes;

  if v_desajustes <> 0 then
    raise exception
      'El resumen de stock y los lotes difieren en % productos',
      v_desajustes;
  end if;

  select pg_get_functiondef(p.oid)
  into v_funcion
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'despachar_remision_desde_central';

  if v_funcion not ilike '%factura_proveedor_id%'
     or v_funcion not ilike '%stock_cantidad_lotes%'
     or v_funcion not ilike '%for update of l skip locked%'
  then
    raise exception
      'La función de despacho no contiene el control transaccional por factura';
  end if;
end;
$$;

rollback;
