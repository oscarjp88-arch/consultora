-- Inventario por cantidad trazable por factura en Bodega Central.
-- Mantiene stock_cantidad como resumen operativo y usa un lote inmutable por
-- movimiento de compra para no mezclar facturas, costos ni precios.

create table if not exists public.stock_cantidad_lotes (
  id uuid primary key default gen_random_uuid(),
  movimiento_entrada_id bigint not null unique
    references public.movimientos(id) on delete restrict,
  producto_id uuid not null
    references public.productos(id) on delete restrict,
  tienda_codigo text not null
    references public.origenes(codigo) on update cascade on delete restrict,
  factura_proveedor_id uuid not null
    references public.facturas_proveedor(id) on delete restrict,
  cantidad integer not null check (cantidad >= 0),
  costo_unitario numeric not null check (costo_unitario >= 0),
  precio_tienda numeric not null check (precio_tienda >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists stock_cantidad_lotes_disponibles_idx
  on public.stock_cantidad_lotes
  (tienda_codigo, producto_id, factura_proveedor_id, created_at)
  where cantidad > 0;

alter table public.stock_cantidad_lotes enable row level security;
revoke all on table public.stock_cantidad_lotes from anon, authenticated;
grant select on table public.stock_cantidad_lotes to authenticated;

drop policy if exists stock_cantidad_lotes_central_lectura
  on public.stock_cantidad_lotes;
create policy stock_cantidad_lotes_central_lectura
  on public.stock_cantidad_lotes
  for select
  to authenticated
  using (public.es_central());

-- Reconstruye los lotes históricos. Primero descuenta salidas que ya tienen
-- factura y después asigna las salidas antiguas sin factura mediante FIFO.
with entradas as (
  select
    m.id as movimiento_entrada_id,
    m.producto_id,
    m.tienda_codigo,
    m.referencia_id::uuid as factura_proveedor_id,
    m.cantidad,
    coalesce(m.costo, 0) as costo_unitario,
    coalesce(m.precio, 0) as precio_tienda,
    m.created_at
  from public.movimientos m
  join public.productos p on p.id = m.producto_id
  where m.tipo = 'compra_entrada'
    and m.tienda_codigo = 'CENTRAL'
    and m.referencia_tipo = 'factura_proveedor'
    and m.referencia_id is not null
    and p.tipo = 'cantidad'
),
salidas_con_factura as (
  select
    ri.producto_id,
    rm.factura_proveedor_id,
    sum(rm.cantidad)::integer as cantidad
  from public.remision_margenes rm
  join public.remision_items ri on ri.id = rm.remision_item_id
  where rm.unidad_id is null
    and rm.factura_proveedor_id is not null
  group by ri.producto_id, rm.factura_proveedor_id
),
entradas_acumuladas as (
  select
    e.*,
    coalesce(s.cantidad, 0) as salida_factura,
    coalesce(
      sum(e.cantidad) over (
        partition by e.producto_id, e.factura_proveedor_id
        order by e.created_at, e.movimiento_entrada_id
        rows between unbounded preceding and 1 preceding
      ),
      0
    )::integer as entrada_previa_factura
  from entradas e
  left join salidas_con_factura s
    on s.producto_id = e.producto_id
   and s.factura_proveedor_id = e.factura_proveedor_id
),
despues_factura as (
  select
    e.*,
    (
      e.cantidad
      - least(
          e.cantidad,
          greatest(e.salida_factura - e.entrada_previa_factura, 0)
        )
    )::integer as cantidad_base
  from entradas_acumuladas e
),
salidas_sin_factura as (
  select
    ri.producto_id,
    sum(rm.cantidad)::integer as cantidad
  from public.remision_margenes rm
  join public.remision_items ri on ri.id = rm.remision_item_id
  where rm.unidad_id is null
    and rm.factura_proveedor_id is null
  group by ri.producto_id
),
bases_acumuladas as (
  select
    d.*,
    coalesce(s.cantidad, 0) as salida_sin_factura,
    coalesce(
      sum(d.cantidad_base) over (
        partition by d.producto_id
        order by d.created_at, d.movimiento_entrada_id
        rows between unbounded preceding and 1 preceding
      ),
      0
    )::integer as base_previa
  from despues_factura d
  left join salidas_sin_factura s on s.producto_id = d.producto_id
)
insert into public.stock_cantidad_lotes (
  movimiento_entrada_id,
  producto_id,
  tienda_codigo,
  factura_proveedor_id,
  cantidad,
  costo_unitario,
  precio_tienda,
  created_at,
  updated_at
)
select
  b.movimiento_entrada_id,
  b.producto_id,
  b.tienda_codigo,
  b.factura_proveedor_id,
  (
    b.cantidad_base
    - least(
        b.cantidad_base,
        greatest(b.salida_sin_factura - b.base_previa, 0)
      )
  )::integer,
  b.costo_unitario,
  b.precio_tienda,
  b.created_at,
  now()
from bases_acumuladas b
on conflict (movimiento_entrada_id) do nothing;

-- Completa trazabilidad antigua cuando el producto solo tuvo una factura de
-- entrada posible. No adivina cuando existen dos o más facturas.
with factura_unica as (
  select m.producto_id, min(m.referencia_id)::uuid as factura_proveedor_id
  from public.movimientos m
  join public.productos p on p.id = m.producto_id
  where m.tipo = 'compra_entrada'
    and m.tienda_codigo = 'CENTRAL'
    and m.referencia_tipo = 'factura_proveedor'
    and m.referencia_id is not null
    and p.tipo = 'cantidad'
  group by m.producto_id
  having count(distinct m.referencia_id) = 1
)
update public.remision_margenes rm
set factura_proveedor_id = fu.factura_proveedor_id
from public.remision_items ri, factura_unica fu
where ri.id = rm.remision_item_id
  and fu.producto_id = ri.producto_id
  and rm.unidad_id is null
  and rm.factura_proveedor_id is null;

update public.remision_items ri
set factura_proveedor_id = rm.factura_proveedor_id
from public.remision_margenes rm
where rm.remision_item_id = ri.id
  and ri.factura_proveedor_id is null
  and rm.factura_proveedor_id is not null;

-- Toda compra futura por cantidad crea automáticamente su lote.
create or replace function public.registrar_lote_cantidad_desde_movimiento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.tipo = 'compra_entrada'
     and new.tienda_codigo = 'CENTRAL'
     and new.referencia_tipo = 'factura_proveedor'
     and new.referencia_id is not null
     and exists (
       select 1
       from public.productos p
       where p.id = new.producto_id and p.tipo = 'cantidad'
     )
  then
    insert into public.stock_cantidad_lotes (
      movimiento_entrada_id,
      producto_id,
      tienda_codigo,
      factura_proveedor_id,
      cantidad,
      costo_unitario,
      precio_tienda,
      created_at,
      updated_at
    )
    values (
      new.id,
      new.producto_id,
      new.tienda_codigo,
      new.referencia_id::uuid,
      new.cantidad,
      coalesce(new.costo, 0),
      coalesce(new.precio, 0),
      new.created_at,
      now()
    )
    on conflict (movimiento_entrada_id) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists movimientos_crear_lote_cantidad
  on public.movimientos;
create trigger movimientos_crear_lote_cantidad
after insert on public.movimientos
for each row
execute function public.registrar_lote_cantidad_desde_movimiento();

revoke all on function public.registrar_lote_cantidad_desde_movimiento()
  from public, anon, authenticated;

-- Lectura controlada para Bodega Central; nunca expone estos costos a tiendas.
create or replace function public.obtener_lotes_cantidad_central()
returns table (
  producto_id uuid,
  factura_proveedor_id uuid,
  cantidad integer,
  costo_unitario numeric,
  precio_tienda numeric,
  factura_numero text,
  factura_fecha date,
  proveedor_nombre text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.es_central() then
    raise exception 'Solo gerencia o auditoria pueden consultar lotes de Bodega Central';
  end if;

  return query
  select
    l.producto_id,
    l.factura_proveedor_id,
    sum(l.cantidad)::integer,
    case
      when sum(l.cantidad) = 0 then 0
      else sum(l.cantidad * l.costo_unitario) / sum(l.cantidad)
    end,
    (array_agg(l.precio_tienda order by l.created_at, l.id))[1],
    fp.numero,
    fp.fecha,
    pr.nombre
  from public.stock_cantidad_lotes l
  join public.facturas_proveedor fp on fp.id = l.factura_proveedor_id
  join public.proveedores pr on pr.id = fp.proveedor_id
  where l.tienda_codigo = 'CENTRAL'
    and l.cantidad > 0
  group by
    l.producto_id,
    l.factura_proveedor_id,
    fp.numero,
    fp.fecha,
    pr.nombre
  order by fp.fecha, fp.numero, l.producto_id;
end;
$$;

revoke all on function public.obtener_lotes_cantidad_central()
  from public, anon;
grant execute on function public.obtener_lotes_cantidad_central()
  to authenticated;

-- Despacho atómico: cuando llega factura_proveedor_id solo consume ese lote;
-- sin filtro conserva FIFO y divide la remisión si cruza dos facturas.
create or replace function public.despachar_remision_desde_central(
  p_tienda_codigo text,
  p_items jsonb,
  p_nota text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_remision_id uuid;
  v_consecutivo bigint;
  v_item jsonb;
  v_producto record;
  v_item_id uuid;
  v_costo_promedio numeric;
  v_precio_tienda_stock numeric;
  v_stock_actual integer;
  v_disponibles integer;
  v_unidad record;
  v_lote record;
  v_total_cantidad integer;
  v_suma_costos numeric;
  v_precio_override numeric;
  v_precio_final numeric;
  v_factura_filtro uuid;
  v_restante integer;
  v_tomar integer;
begin
  if not public.es_central() then
    raise exception 'Solo gerencia o auditoria pueden despachar remisiones';
  end if;

  if p_tienda_codigo is null or p_tienda_codigo = 'CENTRAL' then
    raise exception 'Tienda destino invalida: %', p_tienda_codigo;
  end if;

  perform 1
  from public.origenes
  where codigo = p_tienda_codigo
    and activo = true
    and tipo <> 'central';
  if not found then
    raise exception 'Tienda destino "%" no existe o esta inactiva', p_tienda_codigo;
  end if;

  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'Debe indicar al menos un item';
  end if;

  insert into public.remisiones (
    tienda_codigo,
    estado,
    creada_por,
    nota,
    despachada_at
  )
  values (
    p_tienda_codigo,
    'despachada',
    auth.uid(),
    p_nota,
    now()
  )
  returning id, consecutivo into v_remision_id, v_consecutivo;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select id, tipo, nombre
    into v_producto
    from public.productos
    where id = (v_item->>'producto_id')::uuid;

    if v_producto.id is null then
      raise exception 'Producto % no encontrado', v_item->>'producto_id';
    end if;

    declare
      v_cantidad integer := (v_item->>'cantidad')::integer;
    begin
      if v_cantidad is null or v_cantidad <= 0 then
        raise exception 'Cantidad invalida para "%": %',
          v_producto.nombre, v_cantidad;
      end if;

      v_precio_override := nullif(v_item->>'precio_override', '')::numeric;
      v_factura_filtro := nullif(
        v_item->>'factura_proveedor_id',
        ''
      )::uuid;

      if v_precio_override is not null and v_precio_override < 0 then
        raise exception 'precio_override invalido para "%": %',
          v_producto.nombre, v_precio_override;
      end if;

      perform pg_advisory_xact_lock(
        hashtextextended(v_producto.id::text, 0)
      );

      if v_producto.tipo = 'serializado' then
        select count(*)
        into v_disponibles
        from public.unidades
        where producto_id = v_producto.id
          and tienda_actual = 'CENTRAL'
          and estado = 'disponible'
          and imei is null
          and (
            v_factura_filtro is null
            or factura_proveedor_id = v_factura_filtro
          );

        if v_disponibles < v_cantidad then
          raise exception
            'Stock insuficiente de "%" en la factura elegida: hay % disponibles y se piden %',
            v_producto.nombre, v_disponibles, v_cantidad;
        end if;

        v_total_cantidad := 0;
        v_suma_costos := 0;

        for v_unidad in
          select id, costo_remision, precio_tienda, factura_proveedor_id
          from public.unidades
          where producto_id = v_producto.id
            and tienda_actual = 'CENTRAL'
            and estado = 'disponible'
            and imei is null
            and (
              v_factura_filtro is null
              or factura_proveedor_id = v_factura_filtro
            )
          order by created_at, id
          limit v_cantidad
          for update skip locked
        loop
          v_precio_final := coalesce(
            v_precio_override,
            v_unidad.precio_tienda,
            0
          );
          if v_precio_final = 0 then
            raise exception 'Unidad % de "%" no tiene precio_tienda definido.',
              v_unidad.id, v_producto.nombre;
          end if;

          insert into public.remision_items (
            remision_id,
            producto_id,
            cantidad,
            precio_remision,
            factura_proveedor_id
          )
          values (
            v_remision_id,
            v_producto.id,
            1,
            v_precio_final,
            v_unidad.factura_proveedor_id
          )
          returning id into v_item_id;

          update public.unidades
          set estado = 'en_traslado',
              remision_item_id = v_item_id
          where id = v_unidad.id;

          insert into public.remision_margenes (
            remision_item_id,
            unidad_id,
            factura_proveedor_id,
            costo_oscar,
            cantidad
          )
          values (
            v_item_id,
            v_unidad.id,
            v_unidad.factura_proveedor_id,
            coalesce(v_unidad.costo_remision, 0),
            1
          );

          v_total_cantidad := v_total_cantidad + 1;
          v_suma_costos := v_suma_costos
            + coalesce(v_unidad.costo_remision, 0);
        end loop;

        if v_total_cantidad < v_cantidad then
          raise exception
            'Concurrencia: no se pudieron reservar % unidades de "%" (se reservaron %)',
            v_cantidad, v_producto.nombre, v_total_cantidad;
        end if;

        insert into public.movimientos (
          tipo,
          tienda_codigo,
          producto_id,
          cantidad,
          costo,
          precio,
          referencia_tipo,
          referencia_id,
          usuario
        )
        values (
          'remision_salida_central',
          'CENTRAL',
          v_producto.id,
          v_cantidad,
          v_suma_costos / nullif(v_total_cantidad, 0),
          v_precio_final,
          'remision',
          v_remision_id::text,
          auth.uid()
        );
      else
        select cantidad, costo_promedio, precio_tienda
        into v_stock_actual, v_costo_promedio, v_precio_tienda_stock
        from public.stock_cantidad
        where producto_id = v_producto.id
          and tienda_codigo = 'CENTRAL'
        for update;

        select coalesce(sum(cantidad), 0)::integer
        into v_disponibles
        from public.stock_cantidad_lotes
        where producto_id = v_producto.id
          and tienda_codigo = 'CENTRAL'
          and cantidad > 0
          and (
            v_factura_filtro is null
            or factura_proveedor_id = v_factura_filtro
          );

        if v_stock_actual is null
           or v_stock_actual < v_cantidad
           or v_disponibles < v_cantidad
        then
          raise exception
            'Stock insuficiente de "%" en la factura elegida: hay % disponibles y se piden %',
            v_producto.nombre,
            least(coalesce(v_stock_actual, 0), v_disponibles),
            v_cantidad;
        end if;

        v_restante := v_cantidad;
        v_total_cantidad := 0;
        v_suma_costos := 0;

        for v_lote in
          select
            l.id,
            l.factura_proveedor_id,
            l.cantidad,
            l.costo_unitario,
            l.precio_tienda
          from public.stock_cantidad_lotes l
          join public.facturas_proveedor fp
            on fp.id = l.factura_proveedor_id
          where l.producto_id = v_producto.id
            and l.tienda_codigo = 'CENTRAL'
            and l.cantidad > 0
            and (
              v_factura_filtro is null
              or l.factura_proveedor_id = v_factura_filtro
            )
          order by fp.fecha, l.created_at, l.id
          for update of l skip locked
        loop
          exit when v_restante <= 0;
          v_tomar := least(v_restante, v_lote.cantidad);
          v_precio_final := coalesce(
            v_precio_override,
            v_lote.precio_tienda,
            0
          );

          if v_precio_final = 0 then
            raise exception
              '"%" no tiene precio_tienda definido en el lote seleccionado.',
              v_producto.nombre;
          end if;

          insert into public.remision_items (
            remision_id,
            producto_id,
            cantidad,
            precio_remision,
            factura_proveedor_id
          )
          values (
            v_remision_id,
            v_producto.id,
            v_tomar,
            v_precio_final,
            v_lote.factura_proveedor_id
          )
          returning id into v_item_id;

          insert into public.remision_margenes (
            remision_item_id,
            unidad_id,
            factura_proveedor_id,
            costo_oscar,
            cantidad
          )
          values (
            v_item_id,
            null,
            v_lote.factura_proveedor_id,
            v_lote.costo_unitario,
            v_tomar
          );

          update public.stock_cantidad_lotes
          set cantidad = cantidad - v_tomar,
              updated_at = now()
          where id = v_lote.id;

          insert into public.movimientos (
            tipo,
            tienda_codigo,
            producto_id,
            cantidad,
            costo,
            precio,
            referencia_tipo,
            referencia_id,
            usuario
          )
          values (
            'remision_salida_central',
            'CENTRAL',
            v_producto.id,
            v_tomar,
            v_lote.costo_unitario,
            v_precio_final,
            'remision',
            v_remision_id::text,
            auth.uid()
          );

          v_restante := v_restante - v_tomar;
          v_total_cantidad := v_total_cantidad + v_tomar;
          v_suma_costos := v_suma_costos
            + (v_tomar * v_lote.costo_unitario);
        end loop;

        if v_restante > 0 then
          raise exception
            'Concurrencia: no se pudieron reservar % unidades de "%" (faltaron %)',
            v_cantidad, v_producto.nombre, v_restante;
        end if;

        update public.stock_cantidad as sc
        set
          cantidad = sc.cantidad - v_cantidad,
          costo_promedio = coalesce(
            (
              select
                sum(l.cantidad * l.costo_unitario)
                / nullif(sum(l.cantidad), 0)
              from public.stock_cantidad_lotes l
              where l.producto_id = v_producto.id
                and l.tienda_codigo = 'CENTRAL'
                and l.cantidad > 0
            ),
            sc.costo_promedio
          ),
          precio_tienda = coalesce(
            (
              select l.precio_tienda
              from public.stock_cantidad_lotes l
              join public.facturas_proveedor fp
                on fp.id = l.factura_proveedor_id
              where l.producto_id = v_producto.id
                and l.tienda_codigo = 'CENTRAL'
                and l.cantidad > 0
              order by fp.fecha, l.created_at, l.id
              limit 1
            ),
            sc.precio_tienda
          ),
          factura_proveedor_id = (
            select l.factura_proveedor_id
            from public.stock_cantidad_lotes l
            join public.facturas_proveedor fp
              on fp.id = l.factura_proveedor_id
            where l.producto_id = v_producto.id
              and l.tienda_codigo = 'CENTRAL'
              and l.cantidad > 0
            order by fp.fecha, l.created_at, l.id
            limit 1
          ),
          updated_at = now()
        where sc.producto_id = v_producto.id
          and sc.tienda_codigo = 'CENTRAL';
      end if;
    end;
  end loop;

  return jsonb_build_object(
    'ok', true,
    'remision_id', v_remision_id,
    'consecutivo', v_consecutivo
  );
end;
$$;

revoke all on function public.despachar_remision_desde_central(
  text,
  jsonb,
  text
) from public, anon;
grant execute on function public.despachar_remision_desde_central(
  text,
  jsonb,
  text
) to authenticated;

comment on table public.stock_cantidad_lotes is
  'Lotes por movimiento de compra para preservar factura, costo y precio del inventario por cantidad.';
