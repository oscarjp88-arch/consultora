-- Fase compatible: crea índices y funciones del flujo pendiente -> verificado.
-- No retira todavía las rutas antiguas para permitir despliegue sin interrupción.

begin;

do $$
begin
  if exists (
    select 1
    from public.cuenta_corriente
    where referencia_tipo = 'abono'
      and referencia_id is not null
    group by referencia_id
    having count(*) > 1
  ) then
    raise exception 'Hay abonos duplicados en cuenta_corriente; conciliar antes de migrar';
  end if;

  if exists (
    select 1
    from public.abonos
    where soporte_path is not null
    group by soporte_path
    having count(*) > 1
  ) then
    raise exception 'Hay soportes de abono duplicados; conciliar antes de migrar';
  end if;
end;
$$;

create unique index if not exists cuenta_corriente_abono_referencia_unica
on public.cuenta_corriente (referencia_id)
where referencia_tipo = 'abono' and referencia_id is not null;

create unique index if not exists abonos_soporte_path_unico
on public.abonos (soporte_path)
where soporte_path is not null;

create or replace function public.registrar_abono_pendiente(
  p_tienda_codigo text,
  p_monto numeric,
  p_soporte_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, storage, pg_temp
as $$
declare
  v_rol text;
  v_tienda_usuario text;
  v_abono public.abonos%rowtype;
begin
  select p.rol, p.tienda_codigo
  into v_rol, v_tienda_usuario
  from public.perfiles p
  where p.id = auth.uid()
    and p.activo = true;

  if v_rol is null then
    raise exception 'Usuario sin perfil activo';
  end if;

  if not (
    v_rol = 'gerencia'
    or (v_rol = 'admin_tienda' and v_tienda_usuario = p_tienda_codigo)
  ) then
    raise exception 'No tienes permiso para registrar este abono';
  end if;

  if p_monto is null or p_monto <= 0 then
    raise exception 'El monto debe ser mayor que cero';
  end if;

  if not exists (
    select 1
    from public.origenes o
    where o.codigo = p_tienda_codigo
      and o.tipo = 'propia'
      and o.activo = true
  ) then
    raise exception 'Tienda inválida o inactiva';
  end if;

  if p_soporte_path is null
     or left(p_soporte_path, length(p_tienda_codigo) + 1) <> p_tienda_codigo || '/'
     or p_soporte_path !~ '^[A-Za-z0-9_-]+/[0-9]+_[a-z0-9]{6}\.jpg$' then
    raise exception 'Ruta de soporte inválida';
  end if;

  if not exists (
    select 1
    from storage.objects o
    where o.bucket_id = 'soportes'
      and o.name = p_soporte_path
  ) then
    raise exception 'El soporte no existe en el almacenamiento de Creditek';
  end if;

  insert into public.abonos (
    tienda_codigo,
    monto,
    soporte_path,
    registrado_por
  )
  values (
    p_tienda_codigo,
    p_monto,
    p_soporte_path,
    auth.uid()
  )
  returning * into v_abono;

  return jsonb_build_object(
    'ok', true,
    'abono_id', v_abono.id,
    'estado', 'pendiente',
    'monto', v_abono.monto
  );
end;
$$;

revoke all on function public.registrar_abono_pendiente(text, numeric, text) from public;
grant execute on function public.registrar_abono_pendiente(text, numeric, text) to authenticated;

create or replace function public.verificar_abono_y_aplicar(
  p_abono_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rol text;
  v_abono public.abonos%rowtype;
  v_movimiento public.cuenta_corriente%rowtype;
  v_legacy boolean := false;
begin
  select p.rol
  into v_rol
  from public.perfiles p
  where p.id = auth.uid()
    and p.activo = true;

  if v_rol is distinct from 'gerencia' then
    raise exception 'Solo gerencia puede verificar y aplicar abonos';
  end if;

  select *
  into v_abono
  from public.abonos
  where id = p_abono_id
  for update;

  if not found then
    raise exception 'Abono no encontrado';
  end if;

  if v_abono.verificado_at is not null then
    return jsonb_build_object(
      'ok', true,
      'abono_id', v_abono.id,
      'estado', 'verificado',
      'ya_verificado', true
    );
  end if;

  select *
  into v_movimiento
  from public.cuenta_corriente
  where referencia_tipo = 'abono'
    and referencia_id = v_abono.id::text
  for update;

  if found then
    if v_movimiento.tipo <> 'abono'
       or v_movimiento.tienda_codigo <> v_abono.tienda_codigo
       or v_movimiento.monto <> v_abono.monto then
      raise exception 'El movimiento histórico no coincide con el abono';
    end if;
    v_legacy := true;
  else
    insert into public.cuenta_corriente (
      tienda_codigo,
      tipo,
      concepto,
      monto,
      referencia_tipo,
      referencia_id,
      usuario,
      nota
    )
    values (
      v_abono.tienda_codigo,
      'abono',
      'Consignación verificada',
      v_abono.monto,
      'abono',
      v_abono.id::text,
      auth.uid(),
      'Aplicado al saldo después de verificación de gerencia'
    )
    returning * into v_movimiento;
  end if;

  update public.abonos
  set verificado_por = auth.uid(),
      verificado_at = now()
  where id = v_abono.id;

  return jsonb_build_object(
    'ok', true,
    'abono_id', v_abono.id,
    'movimiento_id', v_movimiento.id,
    'estado', 'verificado',
    'movimiento_legacy', v_legacy
  );
end;
$$;

revoke all on function public.verificar_abono_y_aplicar(uuid) from public;
grant execute on function public.verificar_abono_y_aplicar(uuid) to authenticated;

commit;
