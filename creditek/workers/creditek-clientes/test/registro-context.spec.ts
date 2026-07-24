import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  assertCaptadorAllowed,
  resolveRegistrationContext,
  type PublicRegistrationContext,
} from '../src/registro-context';

const TOKEN = 'a'.repeat(43);
const CONTEXT_ENV = {
  SUPABASE_SERVICE_KEY: 'service-key',
  TOKEN_HASH_SECRET: 'hash-secret',
};

type RowSet = {
  enlaces?: unknown;
  origenes?: unknown;
  captadores?: unknown;
};

function supabaseFetcher(
  rows: RowSet,
  requests: Request[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);

    if (request.url.includes('/enlaces_registro?')) {
      expect(request.url).toContain('token_hash=eq.');
      expect(request.url).toContain('activo=eq.true');
      expect(request.url).toContain('revoked_at=is.null');
      return Response.json(rows.enlaces ?? []);
    }
    if (request.url.includes('/origenes?')) {
      expect(request.url).toContain('codigo=eq.CK-01');
      expect(request.url).toContain('activo=eq.true');
      return Response.json(rows.origenes ?? []);
    }
    if (request.url.includes('/captadores?')) {
      expect(request.url).toContain('origen_codigo=eq.CK-01');
      expect(request.url).toContain('activo=eq.true');
      return Response.json(rows.captadores ?? []);
    }

    throw new Error(`Unexpected request: ${request.url}`);
  }) as typeof fetch;
}

const STORE_ROWS = {
  enlaces: [
    {
      id: 'link-1',
      origen_codigo: 'CK-01',
      captador_id: null,
    },
  ],
  origenes: [{ codigo: 'CK-01', nombre: 'Creditek Centro' }],
  captadores: [
    { id: 'captador-1', nombre: 'Ana' },
    { id: 'captador-2', nombre: 'Luis' },
  ],
};

describe('private registration context', () => {
  it('returns only the token store and its active captators', async () => {
    const requests: Request[] = [];

    const context = await resolveRegistrationContext(
      TOKEN,
      CONTEXT_ENV,
      supabaseFetcher(STORE_ROWS, requests),
    );

    expect(context).toEqual({
      enlaceId: 'link-1',
      tipo: 'tienda',
      origen: { codigo: 'CK-01', nombre: 'Creditek Centro' },
      captadores: [
        { id: 'captador-1', nombre: 'Ana' },
        { id: 'captador-2', nombre: 'Luis' },
      ],
    });
    expect(requests).toHaveLength(3);
  });

  it('allows a store link with no active captators', async () => {
    const context = await resolveRegistrationContext(
      TOKEN,
      CONTEXT_ENV,
      supabaseFetcher({
        enlaces: STORE_ROWS.enlaces,
        origenes: STORE_ROWS.origenes,
        captadores: [],
      }),
    );

    expect(context).toEqual({
      enlaceId: 'link-1',
      tipo: 'tienda',
      origen: { codigo: 'CK-01', nombre: 'Creditek Centro' },
      captadores: [],
    });
  });

  it('rejects a revoked token', async () => {
    await expect(
      resolveRegistrationContext(
        TOKEN,
        CONTEXT_ENV,
        supabaseFetcher({ enlaces: [] }),
      ),
    ).rejects.toThrow('enlace_invalido');
  });

  it('rejects a captator from another store', () => {
    const context: PublicRegistrationContext = {
      enlaceId: 'link-1',
      tipo: 'tienda',
      origen: { codigo: 'CK-01', nombre: 'Creditek Centro' },
      captadores: [{ id: 'captador-1', nombre: 'Ana' }],
    };

    expect(() => assertCaptadorAllowed(context, 'other-store-captator')).toThrow(
      'captador_invalido',
    );
  });

  it('locks the captator for a personal link', async () => {
    const requests: Request[] = [];
    const context = await resolveRegistrationContext(
      TOKEN,
      CONTEXT_ENV,
      supabaseFetcher(
        {
          enlaces: [
            {
              id: 'link-personal',
              origen_codigo: 'CK-01',
              captador_id: 'captador-2',
            },
          ],
          origenes: STORE_ROWS.origenes,
          captadores: [{ id: 'captador-2', nombre: 'Luis' }],
        },
        requests,
      ),
    );

    expect(context.tipo).toBe('personal');
    expect(context.captadores).toEqual([
      { id: 'captador-2', nombre: 'Luis' },
    ]);
    expect(requests[2].url).toContain('id=eq.captador-2');
    expect(() => assertCaptadorAllowed(context, 'captador-1')).toThrow(
      'captador_invalido',
    );
  });

  it('never returns the global origin catalog', async () => {
    const requests: Request[] = [];
    const context = await resolveRegistrationContext(
      TOKEN,
      CONTEXT_ENV,
      supabaseFetcher(STORE_ROWS, requests),
    );

    const originRequests = requests.filter((request) =>
      request.url.includes('/origenes?'),
    );
    expect(originRequests).toHaveLength(1);
    expect(originRequests[0].url).toContain('codigo=eq.CK-01');
    expect(JSON.stringify(context)).not.toContain('token_hash');
    expect(JSON.stringify(context)).not.toContain('service-key');
    expect(context).not.toHaveProperty('origenes');
  });

  it('rejects short tokens before querying Supabase', async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return Response.json([]);
    }) as typeof fetch;

    await expect(
      resolveRegistrationContext('short', CONTEXT_ENV, fetcher),
    ).rejects.toThrow('enlace_invalido');
    expect(called).toBe(false);
  });

  it('fails closed on a non-successful Supabase response', async () => {
    const fetcher = (async () =>
      new Response('unavailable', { status: 503 })) as typeof fetch;

    await expect(
      resolveRegistrationContext(TOKEN, CONTEXT_ENV, fetcher),
    ).rejects.toThrow('contexto_no_disponible');
  });

  it('fails closed on invalid Supabase JSON', async () => {
    const fetcher = (async () =>
      new Response('not-json', {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    await expect(
      resolveRegistrationContext(TOKEN, CONTEXT_ENV, fetcher),
    ).rejects.toThrow('contexto_no_disponible');
  });
});

describe('registration context route and CORS', () => {
  it('registers the context route and reflects the exact allowed origin', async () => {
    const response = await exports.default.fetch(
      new Request('https://worker.test/api/registro/contexto?t=short', {
        headers: { Origin: 'https://registro.crediteksas.com' },
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Enlace inválido o vencido',
    });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://registro.crediteksas.com',
    );
  });

  it('does not grant CORS access to an unapproved origin', async () => {
    const response = await exports.default.fetch(
      new Request('https://worker.test/no-existe', {
        headers: { Origin: 'https://evil.example' },
      }),
    );

    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });

  it('does not grant an unapproved preflight request', async () => {
    const response = await exports.default.fetch(
      new Request('https://worker.test/api/registro/contexto', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });
});
