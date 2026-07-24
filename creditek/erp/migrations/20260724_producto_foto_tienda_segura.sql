-- Permite que admin_tienda cargue fotografías sin concederle UPDATE general
-- sobre productos. Gerencia y auditoría conservan su administración completa.

begin;

create or replace function public.puede_gestionar_foto_producto()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.perfiles p
    where p.id = auth.uid()
      and p.activo = true
      and p.rol in ('gerencia', 'auditoria', 'admin_tienda')
  );
$$;

revoke all on function public.puede_gestionar_foto_producto() from public;
grant execute on function public.puede_gestionar_foto_producto() to authenticated;

drop policy if exists productos_fotos_insert on storage.objects;
create policy productos_fotos_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'productos-fotos'
  and public.puede_gestionar_foto_producto()
);

drop policy if exists productos_fotos_delete on storage.objects;
create policy productos_fotos_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'productos-fotos'
  and public.puede_gestionar_foto_producto()
);

create or replace function public.actualizar_foto_producto_segura(
  p_producto_id uuid,
  p_foto_url text
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_prefijo constant text :=
    'https://jfkmiyvcdfbsbwchyvol.supabase.co/storage/v1/object/public/productos-fotos/';
  v_nombre_objeto text;
  v_resultado jsonb;
begin
  if auth.uid() is null or not public.puede_gestionar_foto_producto() then
    raise exception 'No tienes permiso para gestionar fotos de productos';
  end if;

  if p_producto_id is null then
    raise exception 'Producto inválido';
  end if;

  if p_foto_url is null
     or left(p_foto_url, length(v_prefijo)) <> v_prefijo then
    raise exception 'La foto debe pertenecer al almacenamiento de Creditek';
  end if;

  v_nombre_objeto := substring(p_foto_url from length(v_prefijo) + 1);
  if v_nombre_objeto !~ '^[a-z0-9][a-z0-9._-]*\.(jpg|jpeg|png|webp)$' then
    raise exception 'Nombre de archivo de foto inválido';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'productos-fotos'
      and o.name = v_nombre_objeto
  ) then
    raise exception 'La foto no existe en el almacenamiento de Creditek';
  end if;

  update public.productos
  set foto_url = p_foto_url
  where id = p_producto_id
    and activo = true
  returning jsonb_build_object('id', id, 'foto_url', foto_url)
  into v_resultado;

  if v_resultado is null then
    raise exception 'Producto no encontrado o inactivo';
  end if;

  return v_resultado;
end;
$$;

revoke all on function public.actualizar_foto_producto_segura(uuid, text) from public;
grant execute on function public.actualizar_foto_producto_segura(uuid, text) to authenticated;

commit;
