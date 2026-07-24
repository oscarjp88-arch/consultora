begin;

create extension if not exists pgcrypto;

create table if not exists public.captadores (
  id uuid primary key default gen_random_uuid(),
  origen_codigo text not null references public.origenes(codigo),
  nombre text not null check (length(btrim(nombre)) >= 2),
  tipo text not null check (tipo in ('empleado', 'tercero')),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists captadores_origen_nombre_uidx
  on public.captadores (origen_codigo, lower(btrim(nombre)));

create table if not exists public.enlaces_registro (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  token_sufijo text not null,
  origen_codigo text not null references public.origenes(codigo),
  captador_id uuid null references public.captadores(id),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz null,
  ultima_utilizacion_at timestamptz null,
  check (activo or revoked_at is not null)
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

create table if not exists public.documentos_solicitud (
  id uuid primary key default gen_random_uuid(),
  solicitud_id uuid not null references public.solicitudes(id),
  cliente_id uuid not null references public.clientes(id),
  tipo text not null check (tipo in ('frente', 'reverso', 'selfie')),
  storage_path text not null,
  mime text not null check (mime in ('image/jpeg', 'image/png')),
  tamano_bytes integer not null check (tamano_bytes between 1 and 4194304),
  sha256 text not null,
  created_at timestamptz not null default now(),
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
