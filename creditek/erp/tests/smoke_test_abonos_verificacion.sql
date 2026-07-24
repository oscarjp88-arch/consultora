begin;

do $$
declare
  v_oscar uuid;
  v_abono uuid;
  v_movimientos_antes bigint;
  v_movimientos_despues bigint;
begin
  if to_regprocedure('public.registrar_abono_pendiente(text,numeric,text)') is null then
    raise exception 'Falta registrar_abono_pendiente(text,numeric,text)';
  end if;

  if to_regprocedure('public.verificar_abono_y_aplicar(uuid)') is null then
    raise exception 'Falta verificar_abono_y_aplicar(uuid)';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and indexname = 'cuenta_corriente_abono_referencia_unica'
  ) then
    raise exception 'Falta protección contra doble aplicación';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'cuenta_corriente'
      and cmd in ('INSERT', 'ALL')
  ) then
    raise exception 'Todavía existe una política de escritura directa en cuenta_corriente';
  end if;

  select id into v_oscar
  from public.perfiles
  where rol = 'gerencia'
    and activo = true
  order by id
  limit 1;

  select a.id into v_abono
  from public.abonos a
  where a.verificado_at is null
    and not exists (
      select 1
      from public.cuenta_corriente cc
      where cc.referencia_tipo = 'abono'
        and cc.referencia_id = a.id::text
    )
  order by a.created_at
  limit 1;

  if v_oscar is null or v_abono is null then
    raise exception 'La prueba necesita gerencia y un abono pendiente sin aplicar';
  end if;

  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_oscar, 'role', 'authenticated')::text,
    true
  );

  select count(*) into v_movimientos_antes
  from public.cuenta_corriente
  where referencia_tipo = 'abono'
    and referencia_id = v_abono::text;

  perform public.verificar_abono_y_aplicar(v_abono);
  perform public.verificar_abono_y_aplicar(v_abono);

  select count(*) into v_movimientos_despues
  from public.cuenta_corriente
  where referencia_tipo = 'abono'
    and referencia_id = v_abono::text;

  if v_movimientos_antes <> 0 or v_movimientos_despues <> 1 then
    raise exception 'La verificación no es idempotente';
  end if;
end;
$$;

rollback;
