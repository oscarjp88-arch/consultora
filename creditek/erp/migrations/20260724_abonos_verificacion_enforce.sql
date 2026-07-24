-- Fase final: después de desplegar la UI nueva, bloquea escrituras directas.

begin;

do $$
begin
  if to_regprocedure('public.registrar_abono_pendiente(text,numeric,text)') is null
     or to_regprocedure('public.verificar_abono_y_aplicar(uuid)') is null then
    raise exception 'Primero debe aplicarse 20260724_abonos_verificacion_prepare.sql';
  end if;
end;
$$;

drop policy if exists "central total" on public.abonos;
drop policy if exists "tienda registra abonos" on public.abonos;
drop policy if exists abonos_select_central on public.abonos;
create policy abonos_select_central
on public.abonos
for select
to authenticated
using (public.es_central());

drop policy if exists "central total" on public.cuenta_corriente;
drop policy if exists "tienda registra abono" on public.cuenta_corriente;
drop policy if exists cuenta_corriente_select_central on public.cuenta_corriente;
create policy cuenta_corriente_select_central
on public.cuenta_corriente
for select
to authenticated
using (public.es_central());

revoke insert, update, delete on public.abonos from authenticated;
revoke insert, update, delete on public.cuenta_corriente from authenticated;

commit;
