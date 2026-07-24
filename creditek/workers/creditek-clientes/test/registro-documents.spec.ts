import { describe, expect, it } from 'vitest';
import { signSession } from '../src/registro-security';
import {
  uploadSecureDocument,
  type SecureDocumentsEnv,
} from '../src/registro-documents';

const NOW = Date.parse('2026-07-23T15:00:00.000Z');
const CLIENTE_ID = '33333333-3333-4333-8333-333333333333';
const SOLICITUD_ID = '44444444-4444-4444-8444-444444444444';
const ENV: SecureDocumentsEnv = {
  SUPABASE_SERVICE_KEY: 'service-key',
  REGISTRATION_SIGNING_SECRET: 'signing-secret',
};
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00]);
const base64 = btoa(String.fromCharCode(...jpeg));

type FetchHandler = (request: Request) => Promise<Response> | Response;

function fetcherFrom(handler: FetchHandler, requests: Request[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
}

async function documentSession(overrides: Record<string, unknown> = {}): Promise<string> {
  return signSession({
    purpose: 'documentos',
    cedula: '1066184151',
    celular: '3200000000',
    enlaceId: '11111111-1111-4111-8111-111111111111',
    clienteId: CLIENTE_ID,
    solicitudId: SOLICITUD_ID,
    exp: NOW + 60_000,
    ...overrides,
  } as never, ENV.REGISTRATION_SIGNING_SECRET);
}

function validInput(session: string) {
  return {
    documentos_session: session,
    tipo: 'frente',
    mime: 'image/jpeg',
    foto_base64: base64,
  };
}

function successResponse(request: Request): Response {
  return request.url.includes('/rest/v1/clientes')
    ? Response.json([{ id: CLIENTE_ID }])
    : Response.json([]);
}

describe('request-scoped secure document upload', () => {
  it('rejects files larger than four MiB before decoding or uploading', async () => {
    const result = await uploadSecureDocument(
      { ...validInput(await documentSession()), foto_base64: 'A'.repeat(5_592_408) },
      ENV,
      { now: () => NOW, fetcher: fetcherFrom(() => new Response(null, { status: 500 })) },
    );
    expect(result).toMatchObject({ status: 413, body: { ok: false } });
  });

  it('rejects MIME declarations that do not match image magic bytes', async () => {
    const result = await uploadSecureDocument(
      { ...validInput(await documentSession()), mime: 'image/png' },
      ENV,
      { now: () => NOW, fetcher: fetcherFrom(() => new Response(null, { status: 500 })) },
    );
    expect(result).toMatchObject({ status: 400, body: { ok: false } });
  });

  it('rejects inherited prototype names as document types', async () => {
    const requests: Request[] = [];
    const result = await uploadSecureDocument(
      { ...validInput(await documentSession()), tipo: 'toString' },
      ENV,
      { now: () => NOW, fetcher: fetcherFrom((request) => successResponse(request), requests) },
    );
    expect(result).toMatchObject({ status: 400, body: { ok: false } });
    expect(requests).toHaveLength(0);
  });

  it('rejects malformed, expired, and wrong-purpose upload sessions', async () => {
    const expired = await documentSession({ exp: NOW - 1 });
    const wrongPurpose = await documentSession({ purpose: 'registro' });

    for (const documentos_session of ['malformed.session', expired, wrongPurpose]) {
      await expect(uploadSecureDocument(validInput(documentos_session), ENV, {
        now: () => NOW,
        fetcher: fetcherFrom(() => new Response(null, { status: 500 })),
      })).resolves.toMatchObject({ status: 400, body: { ok: false } });
    }
  });

  it('uses opaque server-bound paths and UUID-only REST filters', async () => {
    const requests: Request[] = [];
    const result = await uploadSecureDocument(validInput(await documentSession()), ENV, {
      now: () => NOW,
      randomUuid: () => '55555555-5555-4555-8555-555555555555',
      fetcher: fetcherFrom((request) => successResponse(request), requests),
    });

    expect(result.status).toBe(200);
    const storage = requests.find((request) => request.url.includes('/storage/v1/object/cedulas/'))!;
    expect(storage.url).toContain(`${CLIENTE_ID}/${SOLICITUD_ID}/frente-55555555-5555-4555-8555-555555555555.jpg`);
    expect(storage.url).not.toContain('1066184151');
    const documentRequest = requests.find((request) => request.url.includes('/rest/v1/documentos_solicitud'))!;
    expect(await documentRequest.clone().json()).toMatchObject({ cliente_id: CLIENTE_ID, solicitud_id: SOLICITUD_ID });
    const clientRequest = requests.find((request) => request.url.includes('/rest/v1/clientes'))!;
    expect(clientRequest.url).toContain(CLIENTE_ID);
    for (const request of requests.filter((request) => request.url.includes('/rest/v1/'))) {
      expect(request.url).not.toContain('1066184151');
    }
  });

  it('ignores attacker-supplied client and request identifiers in favor of the signed session', async () => {
    const requests: Request[] = [];
    const result = await uploadSecureDocument({
      ...validInput(await documentSession()),
      cliente_id: '99999999-9999-4999-8999-999999999999',
      solicitud_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }, ENV, {
      now: () => NOW,
      randomUuid: () => '55555555-5555-4555-8555-555555555555',
      fetcher: fetcherFrom((request) => successResponse(request), requests),
    });

    expect(result.status).toBe(200);
    const storage = requests.find((request) => request.url.includes('/storage/v1/object/cedulas/'))!;
    expect(storage.url).toContain(`${CLIENTE_ID}/${SOLICITUD_ID}/`);
    expect(storage.url).not.toContain('99999999-9999-4999-8999-999999999999');
    const documentRequest = requests.find((request) => request.url.includes('/rest/v1/documentos_solicitud'))!;
    expect(await documentRequest.clone().json()).toMatchObject({
      cliente_id: CLIENTE_ID,
      solicitud_id: SOLICITUD_ID,
    });
  });

  it('uploads before upserting one request document type and syncing its legacy client column', async () => {
    const requests: Request[] = [];
    const result = await uploadSecureDocument(validInput(await documentSession()), ENV, {
      now: () => NOW,
      randomUuid: () => '55555555-5555-4555-8555-555555555555',
      fetcher: fetcherFrom((request) => successResponse(request), requests),
    });

    expect(result.status).toBe(200);
    const storageIndex = requests.findIndex((request) => request.url.includes('/storage/v1/object/cedulas/'));
    const documentIndex = requests.findIndex((request) => request.url.includes('/rest/v1/documentos_solicitud'));
    const clientIndex = requests.findIndex((request) => request.url.includes('/rest/v1/clientes'));
    expect(storageIndex).toBeLessThan(documentIndex);
    expect(documentIndex).toBeLessThan(clientIndex);
    expect(await requests[documentIndex].json()).toMatchObject({ solicitud_id: SOLICITUD_ID, cliente_id: CLIENTE_ID, tipo: 'frente' });
    expect(requests[documentIndex].headers.get('Prefer')).toContain('resolution=merge-duplicates');
    expect(await requests[clientIndex].json()).toHaveProperty('foto_cedula_frente_path');
  });

  it('does not update metadata after upload failure or report success after metadata failure', async () => {
    const uploadFailure: Request[] = [];
    const failedUpload = await uploadSecureDocument(validInput(await documentSession()), ENV, {
      now: () => NOW,
      fetcher: fetcherFrom(() => new Response(null, { status: 500 }), uploadFailure),
    });
    expect(failedUpload.status).toBe(502);
    expect(uploadFailure.some((request) => request.url.includes('/rest/v1/documentos_solicitud'))).toBe(false);

    const metadataFailure: Request[] = [];
    const failedMetadata = await uploadSecureDocument(validInput(await documentSession()), ENV, {
      now: () => NOW,
      fetcher: fetcherFrom((request) => request.url.includes('/storage/v1/object/cedulas/')
        ? new Response(null, { status: 201 })
        : new Response(null, { status: 500 }), metadataFailure),
    });
    expect(failedMetadata).toMatchObject({ status: 502, body: { ok: false } });
  });

  it('does not report success when the exact signed client is not updated', async () => {
    const result = await uploadSecureDocument(validInput(await documentSession()), ENV, {
      now: () => NOW,
      fetcher: fetcherFrom((request) => request.url.includes('/rest/v1/clientes')
        ? Response.json([])
        : request.url.includes('/storage/v1/object/cedulas/')
          ? new Response(null, { status: 201 })
          : Response.json([])),
    });
    expect(result).toMatchObject({ status: 502, body: { ok: false } });
  });
});
