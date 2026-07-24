import { describe, expect, it } from 'vitest';
import { buildSeedPlan, normalizeCaptadorName } from '../scripts/seed-registration-links.mjs';

const origins = Array.from({ length: 28 }, (_, index) => ({
  codigo: `CK-${String(index + 1).padStart(2, '0')}`,
  nombre: `Origen ${index + 1}`,
  activo: true,
}));

function tokenFor(codigo: string): string {
  return `${codigo.replace(/[^A-Z0-9]/g, '').padEnd(43, 'x')}`.slice(0, 43);
}

describe('registration link seed planning', () => {
  it('creates one store link for each supplied work origin while excluding CENTRAL', async () => {
    const plan = await buildSeedPlan({
      origins: [...origins, { codigo: 'CENTRAL', nombre: 'Central', activo: true }],
      captadores: [], tokenSecret: 'seed-secret', tokenFor,
    });

    expect(plan.links).toHaveLength(28);
    expect(plan.links.map((link) => link.codigo)).toEqual(origins.map((origin) => origin.codigo));
    expect(plan.links.some((link) => link.codigo === 'CENTRAL')).toBe(false);
  });

  it('deduplicates normalized captator names within an origin only', async () => {
    const plan = await buildSeedPlan({
      origins: origins.slice(0, 2),
      captadores: [
        { origen_codigo: 'CK-01', nombre: ' Ana  Pérez ', tipo: 'empleado' },
        { origen_codigo: 'CK-01', nombre: 'ana perez', tipo: 'empleado' },
        { origen_codigo: 'CK-02', nombre: 'ANA PÉREZ', tipo: 'tercero' },
      ], tokenSecret: 'seed-secret', tokenFor,
    });

    expect(normalizeCaptadorName(' ÁNA   Pérez ')).toBe('ana perez');
    expect(plan.captadores).toHaveLength(2);
    expect(plan.captadores.map((captador) => captador.origen_codigo)).toEqual(['CK-01', 'CK-02']);
  });

  it('stores HMAC hashes but never raw tokens in Supabase payloads', async () => {
    const raw = tokenFor('CK-01');
    const plan = await buildSeedPlan({
      origins: origins.slice(0, 1), captadores: [], tokenSecret: 'seed-secret', tokenFor,
    });

    const payload = plan.enlaces[0];
    expect(payload.token_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(payload)).not.toContain(raw);
    expect(payload).not.toHaveProperty('token');
    expect(plan.links[0].link).toBe(`https://registro.crediteksas.com/creditek/erp/registro?t=${raw}`);
  });

  it('does not plan duplicate active store links', async () => {
    const plan = await buildSeedPlan({
      origins: origins.slice(0, 2), captadores: [], tokenSecret: 'seed-secret', tokenFor,
      activeStoreLinkOrigins: new Set(['CK-01']),
    });
    expect(plan.links.map((link) => link.codigo)).toEqual(['CK-02']);
  });
});
