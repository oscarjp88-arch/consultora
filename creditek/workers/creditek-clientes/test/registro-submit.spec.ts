import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../src/registro-security';
import {
  isSecureRegistrationRequest,
  submitSecureRegistration,
  type SecureRegistrationEnv,
} from '../src/registro-submit';

const NOW = Date.parse('2026-07-23T15:00:00.000Z');
const TOKEN = 't'.repeat(43);
const ENLACE_ID = '11111111-1111-4111-8111-111111111111';
const CAPTADOR_ID = '22222222-2222-4222-8222-222222222222';
const CLIENTE_ID = '33333333-3333-4333-8333-333333333333';
const SOLICITUD_ID = '44444444-4444-4444-8444-444444444444';
const ENV: SecureRegistrationEnv = {
  SUPABASE_SERVICE_KEY: 'service-key',
  TOKEN_HASH_SECRET: 'token-secret',
  REGISTRATION_SIGNING_SECRET: 'signing-secret',
};

const input = {
  enlace_token: TOKEN,
  captador_id: CAPTADOR_ID,
  registro_session: '',
  nombre_completo: 'Ana Prueba',
  email: 'ana@example.com',
  ciudad: 'Medellín',
  direccion: 'Calle 1 # 2-3',
  producto_interes: 'Electrodomésticos',
  financiera: null,
  referencias: [{ nombre: 'Ref Uno', telefono: '3200000001' }],
  autorizacion_datos: true as const,
  autorizacion_comercial: false,
  autorizacion_version: 'v1',
};

type FetchHandler = (request: Request) => Promise<Response> | Response;

function fetcherFrom(handler: FetchHandler, requests: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
}

function contextResponse(request: Request, captadores = [{ id: CAPTADOR_ID, nombre: 'Asesor Uno' }]): Response | null {
  if (request.url.includes('/enlaces_registro?')) {
    return Response.json([{
      id: ENLACE_ID,
      origen_codigo: 'CK-01',
      captador_id: null,
    }]);
  }
  if (request.url.includes('/origenes?')) {
    return Response.json([{ codigo: 'CK-01', nombre: 'Creditek Centro' }]);
  }
  if (request.url.includes('/captadores?')) return Response.json(captadores);
  return null;
}

async function registrationSession(overrides: Record<string, unknown> = {}): Promise<string> {
  return signSession({
    purpose: 'registro',
    cedula: '1066184151',
    celular: '3200000000',
    enlaceId: ENLACE_ID,
    otpId: '55555555-5555-4555-8555-555555555555',
    exp: NOW + 60_000,
    ...overrides,
  } as never, ENV.REGISTRATION_SIGNING_SECRET);
}

describe('secure registration submission', () => {
  it('rejects a seller from another store before calling the registration RPC', async () => {
    const requests: Request[] = [];
    const result = await submitSecureRegistration(
      { ...input, captador_id: '66666666-6666-4666-8666-666666666666', registro_session: await registrationSession() },
      ENV,
      {
        now: () => NOW,
        fetcher: fetcherFrom((request) => contextResponse(request) ?? new Response(null, { status: 500 }), requests),
      },
    );

    expect(result).toMatchObject({ status: 400, body: { ok: false } });
    expect(requests.some((request) => request.url.includes('/rpc/crear_registro_cliente_seguro'))).toBe(false);
  });

  it('rejects a reused registration session returned as consumed by the single RPC', async () => {
    const result = await submitSecureRegistration(
      { ...input, registro_session: await registrationSession() },
      ENV,
      {
        now: () => NOW,
        fetcher: fetcherFrom((request) => {
          const context = contextResponse(request);
          if (context) return context;
          if (request.url.includes('/rpc/crear_registro_cliente_seguro')) {
            return new Response('otp_invalido_o_consumido', { status: 409 });
          }
          return new Response(null, { status: 500 });
        }),
      },
    );

    expect(result).toMatchObject({ status: 400, body: { ok: false } });
  });

  it('maps Supabase 400 consumed-session errors to a safe client error', async () => {
    const result = await submitSecureRegistration(
      { ...input, registro_session: await registrationSession() },
      ENV,
      {
        now: () => NOW,
        fetcher: fetcherFrom((request) => {
          const context = contextResponse(request);
          if (context) return context;
          if (request.url.includes('/rpc/crear_registro_cliente_seguro')) {
            return new Response('otp_invalido_o_consumido', { status: 400 });
          }
          return new Response(null, { status: 500 });
        }),
      },
    );

    expect(result).toMatchObject({ status: 400, body: { ok: false } });
  });

  it('fails closed when the registration RPC returns non-canonical client or request UUIDs', async () => {
    for (const invalidRow of [
      { cliente_id: 'not-a-uuid', solicitud_id: SOLICITUD_ID },
      { cliente_id: CLIENTE_ID, solicitud_id: 'not-a-uuid' },
    ]) {
      const result = await submitSecureRegistration(
        { ...input, registro_session: await registrationSession() },
        ENV,
        {
          now: () => NOW,
          fetcher: fetcherFrom((request) => contextResponse(request) ?? Response.json([invalidRow])),
        },
      );
      expect(result).toMatchObject({ status: 503, body: { ok: false } });
      expect(result.body).not.toHaveProperty('documentos_session');
    }
  });

  it('derives origin and seller data on the server and calls only the transactional RPC', async () => {
    const requests: Request[] = [];
    const result = await submitSecureRegistration(
      {
        ...input,
        registro_session: await registrationSession(),
        origen_codigo: 'EVIL',
        vendedor_nombre: 'Persona falsa',
        otp_ok: true,
      },
      ENV,
      {
        now: () => NOW,
        fetcher: fetcherFrom((request) => {
          const context = contextResponse(request);
          if (context) return context;
          if (request.url.includes('/rpc/crear_registro_cliente_seguro')) {
            return Response.json([{ cliente_id: CLIENTE_ID, solicitud_id: SOLICITUD_ID }]);
          }
          return new Response(null, { status: 500 });
        }, requests),
      },
    );

    expect(result.status).toBe(200);
    const rpc = requests.find((request) => request.url.includes('/rpc/crear_registro_cliente_seguro'))!;
    expect(await rpc.json()).toMatchObject({
      p_origen_codigo: 'CK-01',
      p_captador_id: CAPTADOR_ID,
      p_enlace_registro_id: ENLACE_ID,
      p_otp_id: '55555555-5555-4555-8555-555555555555',
    });
    expect(await rpc.text().catch(() => '')).not.toContain('Persona falsa');
    expect(requests.some((request) => /\/rest\/v1\/(clientes|solicitudes|referencias|audit_log)/.test(request.url))).toBe(false);
  });

  it('leaves first-origin preservation and new-request creation to one transactional RPC', async () => {
    const requests: Request[] = [];
    await submitSecureRegistration(
      { ...input, registro_session: await registrationSession() },
      ENV,
      {
        now: () => NOW,
        fetcher: fetcherFrom((request) => {
          const context = contextResponse(request);
          if (context) return context;
          if (request.url.includes('/rpc/crear_registro_cliente_seguro')) {
            return Response.json([{ cliente_id: CLIENTE_ID, solicitud_id: SOLICITUD_ID }]);
          }
          return new Response(null, { status: 500 });
        }, requests),
      },
    );

    expect(requests.filter((request) => request.url.includes('/rpc/crear_registro_cliente_seguro'))).toHaveLength(1);
    expect(requests.some((request) => request.url.includes('/rest/v1/clientes'))).toBe(false);
    expect(requests.some((request) => request.url.includes('/rest/v1/solicitudes'))).toBe(false);
  });

  it('returns a 30-minute document session bound to the created client and request', async () => {
    const result = await submitSecureRegistration(
      { ...input, registro_session: await registrationSession() },
      ENV,
      {
        now: () => NOW,
        fetcher: fetcherFrom((request) => contextResponse(request) ?? Response.json([
          { cliente_id: CLIENTE_ID, solicitud_id: SOLICITUD_ID },
        ])),
      },
    );

    expect(result.status).toBe(200);
    const session = String(result.body.documentos_session);
    await expect(verifySession(session, ENV.REGISTRATION_SIGNING_SECRET, NOW)).resolves.toMatchObject({
      purpose: 'documentos', clienteId: CLIENTE_ID, solicitudId: SOLICITUD_ID, exp: NOW + 30 * 60_000,
    });
  });

  it('rejects malformed, expired, and wrong-purpose registration sessions without a fallback', async () => {
    const expired = await registrationSession({ exp: NOW - 1 });
    const wrongPurpose = await registrationSession({ purpose: 'documentos', clienteId: CLIENTE_ID, solicitudId: SOLICITUD_ID });

    for (const registro_session of ['malformed.session', expired, wrongPurpose]) {
      await expect(submitSecureRegistration({ ...input, registro_session }, ENV, {
        now: () => NOW,
        fetcher: fetcherFrom(() => new Response(null, { status: 500 })),
      })).resolves.toMatchObject({ status: 400, body: { ok: false } });
    }
  });

  it('classifies a secure-shaped invalid payload as secure so callers cannot fall back to legacy registration', () => {
    expect(isSecureRegistrationRequest({ enlace_token: TOKEN, registro_session: 'invalid' })).toBe(true);
    expect(isSecureRegistrationRequest({ nombre_completo: 'Ana Prueba' })).toBe(false);
  });

  it('rejects invalid references before resolving the link or invoking the RPC', async () => {
    const requests: Request[] = [];
    const result = await submitSecureRegistration({
      ...input,
      registro_session: await registrationSession(),
      referencias: [{ nombre: 'X', telefono: '300' }],
    }, ENV, {
      now: () => NOW,
      fetcher: fetcherFrom((request) => new Response(null, { status: 500 }), requests),
    });
    expect(result).toMatchObject({ status: 400, body: { ok: false } });
    expect(requests).toHaveLength(0);
  });

  it('caps structurally valid references to two before the transactional RPC', async () => {
    const requests: Request[] = [];
    await submitSecureRegistration({
      ...input,
      registro_session: await registrationSession(),
      referencias: [
        { nombre: 'Ref Uno', telefono: '3200000001' },
        { nombre: 'Ref Dos', telefono: '3200000002', parentesco: 'amigo' },
        { nombre: 'Ref Tres', telefono: '3200000003' },
      ],
    }, ENV, {
      now: () => NOW,
      fetcher: fetcherFrom((request) => contextResponse(request) ?? Response.json([{ cliente_id: CLIENTE_ID, solicitud_id: SOLICITUD_ID }]), requests),
    });
    const rpc = requests.find((request) => request.url.includes('/rpc/crear_registro_cliente_seguro'))!;
    expect((await rpc.json() as { p_referencias: unknown[] }).p_referencias).toHaveLength(2);
  });
});
