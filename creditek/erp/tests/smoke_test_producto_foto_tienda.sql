-- Ejecutar después de la migración. Solo lectura: confirma contrato y políticas.
do $$
begin
  if to_regprocedure('public.actualizar_foto_producto_segura(uuid,text)') is null then
    raise exception 'Falta actualizar_foto_producto_segura(uuid,text)';
  end if;

  if to_regprocedure('public.puede_gestionar_foto_producto()') is null then
    raise exception 'Falta puede_gestionar_foto_producto()';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'productos_fotos_insert'
      and cmd = 'INSERT'
      and with_check like '%puede_gestionar_foto_producto%'
  ) then
    raise exception 'La política segura de carga de fotos no está activa';
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'actualizar_foto_producto_segura'
      and p.prosecdef = true
  ) then
    raise exception 'La función de foto debe ser SECURITY DEFINER';
  end if;
end;
$$;
