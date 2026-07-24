import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { hashOpaqueToken, verifySession } from '../src/registro-security';
import {
  sendSecureOtp,
  verifySecureOtp,
  verifyTurnstile,
  type SecureOtpEnv,
} from '../src/registro-otp';

const TOKEN = 't'.repeat(43);
const NOW = Date.parse('2026-07-23T15:00:00.000Z');
const ENV: SecureOtpEnv = {
  SUPABASE_SERVICE_KEY: 'service-key',
  TOKEN_HASH_SECRET: 'token-secret',
  REGISTRATION_SIGNING_SECRET: 'signing-secret',
  TURNSTILE_SECRET_KEY: 'turnstile-secret',
};
const CONTEXT_ROWS = {
  enlace: {
    id: '11111111-1111-4111-8111-111111111111',
    origen_codigo: 'CK-01',
    captador_id: null,
  },
  origen: { codigo: 'CK-01', nombre: 'Creditek Centro' },
};

type FetchHandler = (request: Request) => Promise<Response> | Response;

function fetcherFrom(
  handler: FetchHandler,
  requests: Request[] = [],
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
}

function contextResponse(request: Request): Response | null {
  if (request.url.includes('/enlaces_registro?')) {
    return Response.json([CONTEXT_ROWS.enlace]);
  }
  if (request.url.includes('/origenes?')) {
    return Response.json([CONTEXT_ROWS.origen]);
  }
  if (request.url.includes('/captadores?')) {
    return Response.json([]);
  }
  return null;
}

describe('Turnstile validation', () => {
  it('accepts only the expected hostname and action', async () => {
    const requests: Request[] = [];
    const fetcher = fetcherFrom((request) =>
      Response.json({
        success: true,
        hostname: 'registro.crediteksas.com',
        action: 'registro-cliente',
      }), requests);

    await expect(
      verifyTurnstile('client-token', '203.0.113.7', 'secret', fetcher),
    ).resolves.toBe(true);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    );
    expect(requests[0].method).toBe('POST');
    expect(await requests[0].json()).toMatchObject({
      secret: 'secret',
      response: 'client-token',
      remoteip: '203.0.113.7',
    });
  });

  it('fails closed on network errors, non-2xx responses, and bad JSON', async () => {
    const networkError = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const non2xx = (async () =>
      new Response('unavailable', { status: 503 })) as typeof fetch;
    const badJson = (async () =>
      new Response('not-json', {
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    await expect(
      verifyTurnstile('token', null, 'secret', networkError),
    ).resolves.toBe(false);
    await expect(
      verifyTurnstile('token', null, 'secret', non2xx),
    ).resolves.toBe(false);
    await expect(
      verifyTurnstile('token', null, 'secret', badJson),
    ).resolves.toBe(false);
  });

  it('rejects hostname or action mismatches', async () => {
    const wrongHostname = (async () =>
      Response.json({
        success: true,
        hostname: 'evil.example',
        action: 'registro-cliente',
      })) as typeof fetch;
    const wrongAction = (async () =>
      Response.json({
        success: true,
        hostname: 'registro.crediteksas.com',
        action: 'other-action',
      })) as typeof fetch;

    await expect(
      verifyTurnstile('token', null, 'secret', wrongHostname),
    ).resolves.toBe(false);
    await expect(
      verifyTurnstile('token', null, 'secret', wrongAction),
    ).resolves.toBe(false);
  });
});

describe('secure OTP send', () => {
  it('rejects OTP send when Turnstile validation fails', async () => {
    let sent = false;
    const result = await sendSecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        turnstile_token: 'invalid-token',
      },
      '203.0.113.7',
      ENV,
      {
        fetcher: fetcherFrom((request) => {
          expect(request.url).toContain('challenges.cloudflare.com');
          return Response.json({ success: false });
        }),
        sendOtp: async () => {
          sent = true;
          return true;
        },
        now: () => NOW,
        generateCode: () => '123456',
      },
    );

    expect(result.status).toBe(400);
    expect(sent).toBe(false);
  });

  it('binds OTP to cedula, phone, and registration link and stores only its hash', async () => {
    const requests: Request[] = [];
    let deliveredCode = '';
    const fetcher = fetcherFrom(async (request) => {
      if (request.url.includes('challenges.cloudflare.com')) {
        return Response.json({
          success: true,
          hostname: 'registro.crediteksas.com',
          action: 'registro-cliente',
        });
      }
      const context = contextResponse(request);
      if (context) return context;
      if (
        request.url.endsWith('/rest/v1/rpc/reservar_otp_registro_seguro') &&
        request.method === 'POST'
      ) {
        return Response.json([{ otp_id: 'otp-new' }]);
      }
      if (
        request.url.includes('/rest/v1/otp_codigos?') &&
        request.method === 'PATCH'
      ) {
        return Response.json([{ id: 'otp-new' }]);
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }, requests);

    const result = await sendSecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        turnstile_token: 'valid-token',
      },
      null,
      ENV,
      {
        fetcher,
        sendOtp: async (_celular, codigo) => {
          deliveredCode = codigo;
          return true;
        },
        now: () => NOW,
        generateCode: () => '123456',
      },
    );

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(deliveredCode).toBe('123456');
    const reservation = requests.find(
      (request) =>
        request.url.endsWith('/rest/v1/rpc/reservar_otp_registro_seguro') &&
        request.method === 'POST',
    );
    expect(reservation).toBeDefined();
    const payload = await reservation!.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      p_cedula: '1066184151',
      p_celular: '3200000000',
      p_enlace_registro_id: CONTEXT_ROWS.enlace.id,
      p_expira_at: new Date(NOW + 5 * 60_000).toISOString(),
    });
    expect(payload.p_codigo_hash).toBe(
      await hashOpaqueToken('otp:123456', ENV.TOKEN_HASH_SECRET),
    );
    expect(payload.p_codigo_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(payload)).not.toContain('"codigo":');
    expect(
      requests.some((request) =>
        request.method === 'GET' &&
        request.url.includes('/otp_codigos?')),
    ).toBe(false);
    expect(
      requests.some((request) =>
        request.method === 'POST' &&
        request.url.endsWith('/rest/v1/otp_codigos')),
    ).toBe(false);

    const deliveryPatch = requests.find(
      (request) =>
        request.method === 'PATCH' &&
        request.url.includes('/otp_codigos?'),
    )!;
    expect(new URL(deliveryPatch.url).searchParams.get('id')).toBe(
      'eq.otp-new',
    );
    expect(await deliveryPatch.json()).toEqual({
      entregado_at: new Date(NOW).toISOString(),
    });
  });

  it('maps atomic phone and shared-link quota failures to 429', async () => {
    async function limitedResult(errorCode: string): Promise<number> {
      const result = await sendSecureOtp(
        {
          enlace_token: TOKEN,
          cedula: '1066184151',
          celular: '3200000000',
          turnstile_token: 'valid-token',
        },
        null,
        ENV,
        {
          fetcher: fetcherFrom((request) => {
            if (request.url.includes('challenges.cloudflare.com')) {
              return Response.json({
                success: true,
                hostname: 'registro.crediteksas.com',
                action: 'registro-cliente',
              });
            }
            const context = contextResponse(request);
            if (context) return context;
            if (
              request.url.endsWith('/rest/v1/rpc/reservar_otp_registro_seguro') &&
              request.method === 'POST'
            ) {
              return Response.json(
                { message: errorCode },
                { status: 409 },
              );
            }
            throw new Error(`Unexpected request: ${request.url}`);
          }),
          sendOtp: async () => true,
          now: () => NOW,
          generateCode: () => '123456',
        },
      );
      return result.status;
    }

    await expect(limitedResult('otp_limite_celular')).resolves.toBe(429);
    await expect(limitedResult('otp_limite_enlace')).resolves.toBe(429);
  });

  it('fails closed when the atomic reservation RPC fails', async () => {
    const result = await sendSecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        turnstile_token: 'valid-token',
      },
      null,
      ENV,
      {
        fetcher: fetcherFrom((request) => {
          if (request.url.includes('challenges.cloudflare.com')) {
            return Response.json({
              success: true,
              hostname: 'registro.crediteksas.com',
              action: 'registro-cliente',
            });
          }
          const context = contextResponse(request);
          if (context) return context;
          if (
            request.url.endsWith('/rest/v1/rpc/reservar_otp_registro_seguro')
          ) {
            return new Response('down', { status: 503 });
          }
          throw new Error(`Unexpected request: ${request.url}`);
        }),
        sendOtp: async () => true,
        now: () => NOW,
        generateCode: () => '123456',
      },
    );

    expect(result.status).toBe(503);
  });

  it('marks failed delivery so it is excluded from future quota', async () => {
    const requests: Request[] = [];
    const result = await sendSecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        turnstile_token: 'valid-token',
      },
      null,
      ENV,
      {
        fetcher: fetcherFrom((request) => {
          if (request.url.includes('challenges.cloudflare.com')) {
            return Response.json({
              success: true,
              hostname: 'registro.crediteksas.com',
              action: 'registro-cliente',
            });
          }
          const context = contextResponse(request);
          if (context) return context;
          if (
            request.url.endsWith('/rest/v1/rpc/reservar_otp_registro_seguro')
          ) {
            return Response.json([{ otp_id: 'otp-failed' }]);
          }
          if (
            request.url.includes('/rest/v1/otp_codigos?') &&
            request.method === 'PATCH'
          ) {
            return Response.json([{ id: 'otp-failed' }]);
          }
          throw new Error(`Unexpected request: ${request.url}`);
        }, requests),
        sendOtp: async () => false,
        now: () => NOW,
        generateCode: () => '123456',
      },
    );

    expect(result.status).toBe(502);
    const failedPatch = requests.find(
      (request) => request.method === 'PATCH',
    )!;
    expect(await failedPatch.json()).toEqual({
      envio_fallido_at: new Date(NOW).toISOString(),
    });
  });
});

describe('secure OTP verification', () => {
  async function verificationFetcher(
    code: string,
    patchRows: unknown = [{ id: 'otp-1' }],
    requests: Request[] = [],
  ): Promise<typeof fetch> {
    const codigoHash = await hashOpaqueToken(
      `otp:${code}`,
      ENV.TOKEN_HASH_SECRET,
    );
    return fetcherFrom(async (request) => {
      const context = contextResponse(request);
      if (context) return context;
      if (
        request.url.includes('/otp_codigos?') &&
        request.method === 'GET'
      ) {
        return Response.json([
          { id: 'otp-1', codigo_hash: codigoHash, intentos: 0 },
        ]);
      }
      if (
        request.url.includes('/otp_codigos?') &&
        request.method === 'PATCH'
      ) {
        return Response.json(patchRows);
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    }, requests);
  }

  it('returns a bound 30-minute signed registration session after a correct code', async () => {
    const result = await verifySecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        codigo: '123456',
      },
      ENV,
      {
        fetcher: await verificationFetcher('123456'),
        now: () => NOW,
      },
    );

    expect(result.status).toBe(200);
    const session = result.body.registro_session;
    expect(typeof session).toBe('string');
    const payload = await verifySession(
      String(session),
      ENV.REGISTRATION_SIGNING_SECRET,
      NOW,
    );
    expect(payload).toEqual({
      purpose: 'registro',
      cedula: '1066184151',
      celular: '3200000000',
      enlaceId: CONTEXT_ROWS.enlace.id,
      otpId: 'otp-1',
      exp: NOW + 30 * 60_000,
    });
    expect(payload.cedula).not.toBe('9999999999');
  });

  it('queries and updates only an exact unexpired, unverified, unconsumed binding', async () => {
    const requests: Request[] = [];
    await verifySecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        codigo: '123456',
      },
      ENV,
      {
        fetcher: await verificationFetcher('123456', [{ id: 'otp-1' }], requests),
        now: () => NOW,
      },
    );

    const otpRequests = requests.filter((request) =>
      request.url.includes('/otp_codigos?'));
    expect(otpRequests).toHaveLength(2);
    for (const request of otpRequests) {
      const url = new URL(request.url);
      expect(url.searchParams.get('id') ?? 'eq.otp-1').toBe('eq.otp-1');
      expect(url.searchParams.get('cedula')).toBe('eq.1066184151');
      expect(url.searchParams.get('celular')).toBe('eq.3200000000');
      expect(url.searchParams.get('enlace_registro_id')).toBe(
        `eq.${CONTEXT_ROWS.enlace.id}`,
      );
      expect(url.searchParams.get('verificado')).toBe('eq.false');
      expect(url.searchParams.get('registro_consumido_at')).toBe('is.null');
      expect(url.searchParams.get('entregado_at')).toBe('not.is.null');
      expect(url.searchParams.get('envio_fallido_at')).toBe('is.null');
      expect(url.searchParams.get('expira_at')).toBe(
        `gt.${new Date(NOW).toISOString()}`,
      );
      expect(url.searchParams.get('select')).not.toContain('codigo,');
    }
    const patch = otpRequests.find((request) => request.method === 'PATCH')!;
    expect(await patch.json()).toEqual({ verificado: true });
  });

  it('compares the domain-separated hash without selecting or writing plaintext code', async () => {
    const requests: Request[] = [];
    const result = await verifySecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        codigo: '654321',
      },
      ENV,
      {
        fetcher: await verificationFetcher('123456', [], requests),
        now: () => NOW,
      },
    );

    expect(result.status).toBe(400);
    const otpRequests = requests.filter((request) =>
      request.url.includes('/otp_codigos?'));
    expect(otpRequests[0].url).toContain('select=id%2Ccodigo_hash%2Cintentos');
    expect(otpRequests[0].url).not.toContain('select=codigo');
    const patchBody = await otpRequests[1].json() as Record<string, unknown>;
    expect(patchBody).toEqual({ intentos: 1 });
    expect(JSON.stringify(patchBody)).not.toContain('654321');
  });

  it('does not issue a session when the atomic verification patch loses a race', async () => {
    const result = await verifySecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        codigo: '123456',
      },
      ENV,
      {
        fetcher: await verificationFetcher('123456', []),
        now: () => NOW,
      },
    );

    expect(result.status).toBe(400);
    expect(result.body).not.toHaveProperty('registro_session');
  });

  it('rejects an already-consumed OTP and enforces the three-attempt maximum', async () => {
    const requests: Request[] = [];
    let verificationReads = 0;
    const wrongHash = await hashOpaqueToken(
      'otp:000000',
      ENV.TOKEN_HASH_SECRET,
    );
    const fetcher = fetcherFrom((request) => {
      const context = contextResponse(request);
      if (context) return context;
      if (request.method === 'GET' && request.url.includes('/otp_codigos?')) {
        verificationReads += 1;
        return Response.json(
          verificationReads === 1
            ? [{ id: 'otp-1', codigo_hash: wrongHash, intentos: 2 }]
            : [],
        );
      }
      if (request.method === 'PATCH') {
        return Response.json([{ id: 'otp-1' }]);
      }
      throw new Error(`Unexpected request: ${request.url}`);
    }, requests);

    const thirdAttempt = await verifySecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        codigo: '123456',
      },
      ENV,
      { fetcher, now: () => NOW },
    );
    const consumed = await verifySecureOtp(
      {
        enlace_token: TOKEN,
        cedula: '1066184151',
        celular: '3200000000',
        codigo: '123456',
      },
      ENV,
      { fetcher, now: () => NOW },
    );

    expect(thirdAttempt.status).toBe(400);
    const wrongPatch = requests.find((request) => request.method === 'PATCH')!;
    expect(await wrongPatch.json()).toEqual({ intentos: 3 });
    expect(consumed.status).toBe(400);
    const finalRead = requests
      .filter((request) =>
        request.method === 'GET' &&
        request.url.includes('/otp_codigos?'))
      .at(-1)!;
    expect(new URL(finalRead.url).searchParams.get('registro_consumido_at')).toBe(
      'is.null',
    );
  });
});

describe('OTP routes and compatibility', () => {
  it('returns only the public Turnstile site key with exact CORS', async () => {
    const response = await exports.default.fetch(
      new Request('https://worker.test/api/registro/config', {
        headers: { Origin: 'https://registro.crediteksas.com' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toEqual({ turnstile_site_key: '' });
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(
      'https://registro.crediteksas.com',
    );
  });

  it('preserves legacy OTP validation while the compatibility flag is enabled', async () => {
    const response = await exports.default.fetch(
      new Request('https://worker.test/api/otp/enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ celular: 'invalido' }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Celular inválido',
    });
  });
});
