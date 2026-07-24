import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('creditek-clientes baseline', () => {
  it('keeps unknown routes closed', async () => {
    const response = await exports.default.fetch(
      new Request('https://worker.test/no-existe'),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      error: 'Ruta no encontrada',
    });
  });
});
