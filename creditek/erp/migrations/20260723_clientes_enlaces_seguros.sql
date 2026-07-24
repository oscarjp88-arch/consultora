begin;

do $preflight$
declare
  v_incompatibles text;
begin
  select string_agg(
    format(
      '%I.%I esperado %s, encontrado %s',
      expected.table_name,
      expected.column_name,
      array_to_string(expected.allowed_udt_names, '/'),
      coalesce(actual.udt_name, 'ausente')
    ),
    '; ' order by expected.table_name, expected.column_name
  )
  into v_incompatibles
  from (
    values
      ('origenes', 'codigo', array['text', 'varchar']),
      ('clientes', 'id', array['uuid']),
      ('clientes', 'cedula', array['text', 'varchar']),
      ('clientes', 'nombre_completo', array['text', 'varchar']),
      ('clientes', 'celular', array['text', 'varchar']),
      ('clientes', 'celular_verificado', array['bool']),
      ('clientes', 'email', array['text', 'varchar']),
      ('clientes', 'ciudad', array['text', 'varchar']),
      ('clientes', 'direccion', array['text', 'varchar']),
      ('clientes', 'origen_codigo', array['text', 'varchar']),
      ('clientes', 'fuente', array['text', 'varchar']),
      ('clientes', 'autorizacion_datos', array['bool']),
      ('clientes', 'autorizacion_comercial', array['bool']),
      ('clientes', 'autorizacion_timestamp', array['timestamptz']),
      ('clientes', 'autorizacion_version', array['text', 'varchar']),
      ('clientes', 'updated_at', array['timestamptz']),
      ('referencias', 'cliente_id', array['uuid']),
      ('referencias', 'nombre', array['text', 'varchar']),
      ('referencias', 'telefono', array['text', 'varchar']),
      ('referencias', 'parentesco', array['text', 'varchar']),
      ('solicitudes', 'id', array['uuid']),
      ('solicitudes', 'cliente_id', array['uuid']),
      ('solicitudes', 'origen_codigo', array['text', 'varchar']),
      ('solicitudes', 'vendedor_nombre', array['text', 'varchar']),
      ('solicitudes', 'producto_interes', array['text', 'varchar']),
      ('solicitudes', 'financiera', array['text', 'varchar']),
      ('solicitudes', 'estado_validacion', array['text', 'varchar']),
      ('otp_codigos', 'id', array['uuid']),
      ('otp_codigos', 'celular', array['text', 'varchar']),
      ('otp_codigos', 'codigo', array['text', 'varchar']),
      ('otp_codigos', 'verificado', array['bool']),
      ('otp_codigos', 'expira_at', array['timestamptz']),
      ('audit_log', 'usuario', array['text', 'varchar']),
      ('audit_log', 'accion', array['text', 'varchar']),
      ('audit_log', 'tabla', array['text', 'varchar']),
      ('audit_log', 'registro_id', array['uuid']),
      ('audit_log', 'detalle', array['jsonb'])
  ) as expected(table_name, column_name, allowed_udt_names)
  left join information_schema.columns as actual
    on actual.table_schema = 'public'
    and actual.table_name = expected.table_name
    and actual.column_name = expected.column_name
  where actual.column_name is null
    or not (actual.udt_name = any(expected.allowed_udt_names))
    or (
      expected.table_name = 'otp_codigos'
      and expected.column_name = 'codigo'
      and actual.character_maximum_length is not null
      and actual.character_maximum_length < 6
    );

  if v_incompatibles is not null then
    raise exception 'preflight_esquema_incompatible:%', v_incompatibles;
  end if;

  if not exists (
    select 1
    from pg_catalog.pg_index as index_definition
    cross join lateral unnest(index_definition.indkey)
      with ordinality as key_column(attnum, position)
    join pg_catalog.pg_attribute as attribute_definition
      on attribute_definition.attrelid = index_definition.indrelid
      and attribute_definition.attnum = key_column.attnum
    where index_definition.indrelid = to_regclass('public.clientes')
      and index_definition.indisunique
      and index_definition.indisvalid
      and index_definition.indisready
      and index_definition.indislive
      and index_definition.indimmediate
      and index_definition.indpred is null
      and index_definition.indexprs is null
      and key_column.position <= index_definition.indnkeyatts
    group by index_definition.indexrelid
    having array_agg(
      attribute_definition.attname::text order by key_column.position
    ) = array['cedula']::text[]
  ) then
    raise exception
      'preflight_esquema_incompatible:clientes.cedula_sin_indice_unico';
  end if;
end;
$preflight$;

create extension if not exists pgcrypto;

create table if not exists public.captadores (
  id uuid primary key default gen_random_uuid(),
  origen_codigo text not null references public.origenes(codigo),
  nombre text not null check (length(btrim(nombre)) >= 2),
  tipo text not null check (tipo in ('empleado', 'tercero')),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, origen_codigo)
);

create unique index if not exists captadores_origen_nombre_uidx
  on public.captadores (origen_codigo, lower(btrim(nombre)));

create table if not exists public.enlaces_registro (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  token_sufijo text not null
    check (token_sufijo ~ '^[A-Za-z0-9_-]{4,12}$'),
  origen_codigo text not null references public.origenes(codigo),
  captador_id uuid null,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  ultima_utilizacion_at timestamptz null,
  foreign key (captador_id, origen_codigo)
    references public.captadores (id, origen_codigo),
  check (activo = (revoked_at is null))
);

create index if not exists enlaces_registro_origen_idx
  on public.enlaces_registro (origen_codigo);

alter table public.solicitudes
  add column if not exists captador_id uuid null
    references public.captadores(id);
alter table public.solicitudes
  add column if not exists enlace_registro_id uuid null
    references public.enlaces_registro(id);

alter table public.otp_codigos
  add column if not exists cedula text null;
alter table public.otp_codigos
  add column if not exists enlace_registro_id uuid null
    references public.enlaces_registro(id);
alter table public.otp_codigos
  add column if not exists codigo_hash text null;
alter table public.otp_codigos
  add column if not exists registro_consumido_at timestamptz null;

do $migration$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.otp_codigos'::regclass
      and conname = 'otp_codigos_registro_seguro_check'
  ) then
    alter table public.otp_codigos
      add constraint otp_codigos_registro_seguro_check check (
        enlace_registro_id is null or (
          codigo_hash is not null
          and codigo_hash ~ '^[A-Za-z0-9_-]{43}$'
          and codigo = 'HASHED'
        )
      );
  end if;
end;
$migration$;

create or replace function public.proteger_otp_registro_seguro()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.enlace_registro_id is not null then
    if new.codigo_hash is null
      or new.codigo_hash !~ '^[A-Za-z0-9_-]{43}$' then
      raise exception 'codigo_hash_invalido';
    end if;
    new.codigo := 'HASHED';
  end if;
  return new;
end;
$function$;

create or replace trigger otp_codigos_proteger_registro_seguro
before insert or update of enlace_registro_id, codigo_hash, codigo
on public.otp_codigos
for each row
execute function public.proteger_otp_registro_seguro();

revoke all on function public.proteger_otp_registro_seguro()
  from public, anon, authenticated;
grant execute on function public.proteger_otp_registro_seguro()
  to service_role;

create unique index if not exists solicitudes_id_cliente_uidx
  on public.solicitudes (id, cliente_id);

create table if not exists public.documentos_solicitud (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null,
  cliente_id uuid not null,
  tipo text not null check (tipo in ('frente', 'reverso', 'selfie')),
  storage_path text not null,
  mime text not null check (mime in ('image/jpeg', 'image/png')),
  tamano_bytes integer not null check (tamano_bytes between 1 and 4194304),
  sha256 text not null,
  created_at timestamptz not null default now(),
  foreign key (solicitud_id, cliente_id)
    references public.solicitudes (id, cliente_id),
  unique (solicitud_id, tipo)
);

alter table public.captadores enable row level security;
alter table public.enlaces_registro enable row level security;
alter table public.documentos_solicitud enable row level security;

revoke all on public.captadores from anon;
revoke all on public.enlaces_registro from anon;
revoke all on public.documentos_solicitud from anon;

create or replace function public.crear_registro_cliente_seguro(
  p_cedula text,
  p_nombre_completo text,
  p_celular text,
  p_email text,
  p_ciudad text,
  p_direccion text,
  p_origen_codigo text,
  p_captador_id uuid,
  p_enlace_registro_id uuid,
  p_otp_id uuid,
  p_producto_interes text,
  p_financiera text,
  p_referencias jsonb,
  p_autorizacion_comercial boolean,
  p_autorizacion_version text
) returns table(cliente_id uuid, solicitud_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cliente_id uuid;
  v_solicitud_id uuid;
  v_captador_nombre text;
  v_otp_id uuid;
begin
  perform 1
  from public.enlaces_registro
  where id = p_enlace_registro_id
    and origen_codigo = p_origen_codigo
    and activo = true
    and revoked_at is null
    and (captador_id is null or captador_id = p_captador_id);
  if not found then
    raise exception 'enlace_invalido';
  end if;

  select nombre into v_captador_nombre
  from public.captadores
  where id = p_captador_id
    and origen_codigo = p_origen_codigo
    and activo = true;
  if v_captador_nombre is null then
    raise exception 'captador_invalido';
  end if;

  update public.otp_codigos
  set registro_consumido_at = now()
  where id = p_otp_id
    and cedula = p_cedula
    and celular = p_celular
    and enlace_registro_id = p_enlace_registro_id
    and verificado = true
    and registro_consumido_at is null
    and expira_at > now()
  returning id into v_otp_id;
  if v_otp_id is null then
    raise exception 'otp_invalido_o_consumido';
  end if;

  insert into public.clientes (
    cedula, nombre_completo, celular, celular_verificado, email, ciudad,
    direccion, origen_codigo, fuente, autorizacion_datos,
    autorizacion_comercial, autorizacion_timestamp,
    autorizacion_version, updated_at
  ) values (
    p_cedula, btrim(p_nombre_completo), p_celular, true,
    nullif(btrim(coalesce(p_email, '')), ''), btrim(p_ciudad),
    btrim(p_direccion), p_origen_codigo, 'formulario', true,
    p_autorizacion_comercial, now(), p_autorizacion_version, now()
  )
  on conflict (cedula) do update set
    nombre_completo = excluded.nombre_completo,
    celular = excluded.celular,
    celular_verificado = true,
    email = coalesce(excluded.email, public.clientes.email),
    ciudad = excluded.ciudad,
    direccion = excluded.direccion,
    autorizacion_datos = true,
    autorizacion_comercial = excluded.autorizacion_comercial,
    autorizacion_timestamp = excluded.autorizacion_timestamp,
    autorizacion_version = excluded.autorizacion_version,
    updated_at = now()
  returning id into v_cliente_id;

  insert into public.solicitudes (
    cliente_id, origen_codigo, captador_id, enlace_registro_id,
    vendedor_nombre, producto_interes, financiera, estado_validacion
  ) values (
    v_cliente_id, p_origen_codigo, p_captador_id, p_enlace_registro_id,
    v_captador_nombre, nullif(btrim(p_producto_interes), ''),
    nullif(p_financiera, ''), 'pendiente'
  )
  returning id into v_solicitud_id;

  insert into public.referencias (
    cliente_id, nombre, telefono, parentesco
  )
  select
    v_cliente_id,
    btrim(x.nombre),
    btrim(x.telefono),
    nullif(btrim(x.parentesco), '')
  from jsonb_to_recordset(coalesce(p_referencias, '[]'::jsonb))
    as x(nombre text, telefono text, parentesco text)
  where length(btrim(coalesce(x.nombre, ''))) >= 2
    and btrim(coalesce(x.telefono, '')) ~ '^3[0-9]{9}$'
  limit 2;

  insert into public.audit_log (
    usuario, accion, tabla, registro_id, detalle
  ) values (
    v_captador_nombre, 'registro_formulario_seguro', 'solicitudes',
    v_solicitud_id,
    jsonb_build_object(
      'origen_codigo', p_origen_codigo,
      'captador_id', p_captador_id,
      'enlace_registro_id', p_enlace_registro_id
    )
  );

  return query select v_cliente_id, v_solicitud_id;
end;
$$;

revoke all on function public.crear_registro_cliente_seguro(
  text, text, text, text, text, text, text, uuid, uuid, uuid, text, text,
  jsonb, boolean, text
) from public, anon, authenticated;
grant execute on function public.crear_registro_cliente_seguro(
  text, text, text, text, text, text, text, uuid, uuid, uuid, text, text,
  jsonb, boolean, text
) to service_role;

commit;
