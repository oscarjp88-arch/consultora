import { describe, expect, it } from 'vitest';
import {
  detectImage,
  generateOpaqueToken,
  generateOtp,
  hashOpaqueToken,
  signSession,
  verifySession,
} from '../src/registro-security';

const payload = {
  purpose: 'registro' as const,
  cedula: '1066184151',
  celular: '3200000000',
  enlaceId: 'e1',
  otpId: 'o1',
  exp: 2_000,
};

describe('secure registration primitives', () => {
  it('generates opaque non-enumerable tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();

    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).not.toBe(a);
  });

  it('hashes equal tokens equally and different tokens differently', async () => {
    const first = await hashOpaqueToken('uno', 'secreto');
    const same = await hashOpaqueToken('uno', 'secreto');
    const other = await hashOpaqueToken('dos', 'secreto');

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(same).toBe(first);
    expect(other).not.toBe(first);
  });

  it('generates six-digit OTPs', () => {
    expect(generateOtp()).toMatch(/^\d{6}$/);
  });

  it('returns a verified session payload', async () => {
    const token = await signSession(payload, 'secreto');

    await expect(verifySession(token, 'secreto', 1_999)).resolves.toEqual(payload);
  });

  it('rejects expired sessions', async () => {
    const token = await signSession(payload, 'secreto');

    await expect(verifySession(token, 'secreto', 2_001)).rejects.toThrow('sesion_vencida');
  });

  it('rejects sessions with a changed signature', async () => {
    const token = await signSession(payload, 'secreto');
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    await expect(verifySession(tampered, 'secreto')).rejects.toThrow('sesion_invalida');
  });

  it('normalizes malformed session inputs to a controlled error', async () => {
    await expect(verifySession('not.a.valid.session', 'secreto')).rejects.toThrow(
      'sesion_invalida',
    );
    await expect(verifySession('%%%%.%%%%', 'secreto')).rejects.toThrow('sesion_invalida');
  });

  it('rejects sessions with an unsupported purpose', async () => {
    await expect(
      signSession({ ...payload, purpose: 'otro' } as unknown as typeof payload, 'secreto'),
    ).rejects.toThrow('sesion_invalida');
  });

  it('recognizes JPEG and PNG magic bytes only', () => {
    expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe('image/jpeg');
    expect(
      detectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(detectImage(new TextEncoder().encode('<script>'))).toBeNull();
  });
});
