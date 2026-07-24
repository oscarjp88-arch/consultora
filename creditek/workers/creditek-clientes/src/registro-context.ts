import { hashOpaqueToken } from './registro-security';

const SUPABASE_URL = 'https://jfkmiyvcdfbsbwchyvol.supabase.co';

export interface RegistrationContextEnv {
  SUPABASE_SERVICE_KEY: string;
  TOKEN_HASH_SECRET: string;
}

export interface PublicRegistrationContext {
  enlaceId: string;
  tipo: 'tienda' | 'personal';
  origen: { codigo: string; nombre: string };
  captadores: Array<{ id: string; nombre: string }>;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface LinkRow {
  id: string;
  origen_codigo: string;
  captador_id: string | null;
}

interface OriginRow {
  codigo: string;
  nombre: string;
}

interface CaptadorRow {
  id: string;
  nombre: string;
}

function error(code: string): Error {
  return new Error(code);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isLinkRow(value: unknown): value is LinkRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    isString(row.id) &&
    isString(row.origen_codigo) &&
    (row.captador_id === null || isString(row.captador_id))
  );
}

function isOriginRow(value: unknown): value is OriginRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return isString(row.codigo) && isString(row.nombre);
}

function isCaptadorRow(value: unknown): value is CaptadorRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return isString(row.id) && isString(row.nombre);
}

function supabaseUrl(
  table: 'enlaces_registro' | 'origenes' | 'captadores',
  filters: Record<string, string>,
): URL {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [name, value] of Object.entries(filters)) {
    url.searchParams.set(name, value);
  }
  return url;
}

async function fetchRows(
  url: URL,
  env: RegistrationContextEnv,
  fetcher: Fetcher,
): Promise<unknown[]> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(url, {
        headers: {
          apikey: env.SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        },
      }),
    );
  } catch {
    throw error('contexto_no_disponible');
  }

  if (!response.ok) throw error('contexto_no_disponible');

  try {
    const value: unknown = await response.json();
    if (!Array.isArray(value)) throw error('contexto_no_disponible');
    return value;
  } catch {
    throw error('contexto_no_disponible');
  }
}

export async function resolveRegistrationContext(
  token: string,
  env: RegistrationContextEnv,
  fetcher: Fetcher = fetch,
): Promise<PublicRegistrationContext> {
  if (typeof token !== 'string' || token.length < 32) {
    throw error('enlace_invalido');
  }

  let tokenHash: string;
  try {
    tokenHash = await hashOpaqueToken(token, env.TOKEN_HASH_SECRET);
  } catch {
    throw error('contexto_no_disponible');
  }

  const linkRows = await fetchRows(
    supabaseUrl('enlaces_registro', {
      token_hash: `eq.${tokenHash}`,
      activo: 'eq.true',
      revoked_at: 'is.null',
      select: 'id,origen_codigo,captador_id',
      limit: '1',
    }),
    env,
    fetcher,
  );
  if (linkRows.length !== 1 || !isLinkRow(linkRows[0])) {
    throw error('enlace_invalido');
  }
  const link = linkRows[0];

  const originRows = await fetchRows(
    supabaseUrl('origenes', {
      codigo: `eq.${link.origen_codigo}`,
      activo: 'eq.true',
      select: 'codigo,nombre',
      limit: '1',
    }),
    env,
    fetcher,
  );
  if (
    originRows.length !== 1 ||
    !isOriginRow(originRows[0]) ||
    originRows[0].codigo !== link.origen_codigo
  ) {
    throw error('origen_invalido');
  }
  const origin = originRows[0];

  const captadorFilters: Record<string, string> = {
    origen_codigo: `eq.${link.origen_codigo}`,
    activo: 'eq.true',
    select: 'id,nombre',
    order: 'nombre',
  };
  if (link.captador_id !== null) {
    captadorFilters.id = `eq.${link.captador_id}`;
  }

  const captadorRows = await fetchRows(
    supabaseUrl('captadores', captadorFilters),
    env,
    fetcher,
  );
  if (
    captadorRows.length === 0 ||
    !captadorRows.every(isCaptadorRow) ||
    (link.captador_id !== null &&
      (captadorRows.length !== 1 ||
        captadorRows[0].id !== link.captador_id))
  ) {
    throw error('captador_invalido');
  }

  return {
    enlaceId: link.id,
    tipo: link.captador_id === null ? 'tienda' : 'personal',
    origen: { codigo: origin.codigo, nombre: origin.nombre },
    captadores: captadorRows.map(({ id, nombre }) => ({ id, nombre })),
  };
}

export function assertCaptadorAllowed(
  context: PublicRegistrationContext,
  captadorId: string,
): void {
  if (
    !isString(captadorId) ||
    !context.captadores.some((captador) => captador.id === captadorId)
  ) {
    throw error('captador_invalido');
  }
}
