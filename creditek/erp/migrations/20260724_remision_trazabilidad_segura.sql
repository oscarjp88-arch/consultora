-- Creditek ERP · trazabilidad segura de remisiones para garantías
--
-- La tienda necesita ver proveedor, factura y fecha de compra, pero nunca
-- costo_oscar ni los márgenes internos de Creditek. La función valida el rol
-- y la tienda antes de devolver únicamente esos campos permitidos.

create or replace function public.obtener_trazabilidad_remision(
  p_remision_id uuid
)
returns table (
  remision_item_id uuid,
  factura_id uuid,
  numero text,
  fecha date,
  proveedor text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct
    ri.id as remision_item_id,
    fp.id as factura_id,
    fp.numero,
    fp.fecha,
    pr.nombre as proveedor
  from public.remision_items ri
  join public.remisiones r
    on r.id = ri.remision_id
  join public.remision_margenes rm
    on rm.remision_item_id = ri.id
  join public.facturas_proveedor fp
    on fp.id = coalesce(rm.factura_proveedor_id, ri.factura_proveedor_id)
  join public.proveedores pr
    on pr.id = fp.proveedor_id
  where ri.remision_id = p_remision_id
    and auth.uid() is not null
    and (
      public.es_central()
      or (
        public.rol_actual() = 'admin_tienda'
        and public.tienda_actual() = r.tienda_codigo
      )
    )
  order by ri.id, fp.fecha, fp.numero;
$$;

revoke all on function public.obtener_trazabilidad_remision(uuid)
  from public, anon, authenticated;
grant execute on function public.obtener_trazabilidad_remision(uuid) to authenticated;

comment on function public.obtener_trazabilidad_remision(uuid) is
  'Expone a usuarios autorizados proveedor, factura y fecha de una remisión sin costos ni márgenes internos.';
