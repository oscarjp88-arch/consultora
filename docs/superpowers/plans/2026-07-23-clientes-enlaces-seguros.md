# Secure Client Registration Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace enumerable store links and free-text sellers with private, revocable registration links and store-scoped captators while preserving the live Creditek client-registration flow.

**Architecture:** Keep the public HTML static and move every trust decision into the `creditek-clientes` Worker. Add additive Supabase tables for captators, hashed links, and request-scoped documents; split the Worker’s registration concerns into focused modules; preserve legacy fields for seven days; and deploy Worker-first with an immediate rollback path.

**Tech Stack:** Cloudflare Workers, TypeScript, Wrangler 4, Vitest 4.1+, `@cloudflare/vitest-pool-workers`, Supabase PostgREST/Storage/RPC, Cloudflare Turnstile, static HTML/JavaScript, Node test runner, Google Sheets.

## Global Constraints

- Do not modify Sofía, `creditek-bot`, sales, credits, or portfolio behavior.
- Do not add financed value, installment count/value, or interest rate to the client registration or new tables.
- Do not delete or change equivalent fields that already exist in sales or credits.
- Use `https://registro.crediteksas.com` for public registration links.
- The generic registration URL must never enumerate stores or allies.
- Store only hashes of private registration tokens in Supabase.
- Keep legacy `?origen=` links for exactly seven calendar days after confirmed distribution of the new links.
- Keep `vendedor_nombre` and the latest client-photo columns during the transition.
- Use additive SQL only; no table, column, bucket, user, or historical row may be deleted.
- Keep the `cedulas` bucket private.
- Never print, commit, or place service keys, Turnstile secrets, signing secrets, OTPs, or raw private tokens in logs.
- Production deployment requires a recorded Worker version, database backup, static-site commit, rollback command, and explicit live verification.

---

### Task 1: Create the isolated implementation workspace and baseline

**Files:**
- Modify: `creditek/workers/creditek-clientes/package.json`
- Create: `creditek/workers/creditek-clientes/vitest.config.ts`
- Create: `creditek/workers/creditek-clientes/test/tsconfig.json`
- Create: `creditek/workers/creditek-clientes/test/baseline.spec.ts`

**Interfaces:**
- Consumes: existing `creditek-clientes` Worker and `wrangler.toml`.
- Produces: a repeatable Workers-runtime test command used by Tasks 3–6.

- [ ] **Step 1: Create an isolated worktree**

Use `superpowers:using-git-worktrees`. Create branch
`codex/clientes-enlaces-seguros` under the repository’s ignored
`.worktrees/` directory. Preserve untracked `TASKS.md` and `dashboard.html`
in the main checkout; do not copy or commit them.

- [ ] **Step 2: Record the clean baseline**

Run:

```bash
git status --short --branch
node --test test/sofia-metricas-panel.test.mjs
cd creditek/workers/creditek-clientes
npx tsc --noEmit
npx wrangler deploy --dry-run
```

Expected:

```text
2 panel tests pass
TypeScript exits 0
Wrangler dry-run exits 0
```

If any baseline command fails, stop and report the pre-existing failure before
changing production code.

- [ ] **Step 3: Add the Workers test dependencies**

Preserve the existing compatible TypeScript, Wrangler, and Workers types.
Install the current Workers pool compatible with Vitest 4.1+:

```bash
npm install --save-dev vitest@^4.1.0 @cloudflare/vitest-pool-workers
npm pkg set scripts.test="vitest run"
npm pkg set scripts.typecheck="tsc --noEmit"
```

Expected: installation completes and `npm audit` reports no known
vulnerabilities. Commit the exact compatible versions resolved in
`package-lock.json`.

- [ ] **Step 4: Configure the Workers test pool**

Create `vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
      },
    },
  },
});
```

Create `test/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "types": [
      "@cloudflare/workers-types",
      "@cloudflare/vitest-pool-workers"
    ]
  },
  "include": ["./**/*.ts", "../src/**/*.ts"]
}
```

- [ ] **Step 5: Write and run the baseline route test**

Create `test/baseline.spec.ts`:

```ts
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
```

Run:

```bash
npm test
```

Expected: `1 passed`.

- [ ] **Step 6: Commit the test foundation**

```bash
git add creditek/workers/creditek-clientes/package.json \
  creditek/workers/creditek-clientes/package-lock.json \
  creditek/workers/creditek-clientes/vitest.config.ts \
  creditek/workers/creditek-clientes/test
git commit -m "test: add client worker test foundation"
```

---

### Task 2: Add the additive Supabase schema and transaction contract

**Files:**
- Create: `creditek/erp/migrations/20260723_clientes_enlaces_seguros.sql`
- Create: `test/clientes-registration-migration.test.mjs`

**Interfaces:**
- Consumes: existing `origenes`, `clientes`, `referencias`, `solicitudes`,
  `otp_codigos`, and `audit_log` tables.
- Produces: `captadores`, `enlaces_registro`, `documentos_solicitud`, additive
  request columns, and RPC `crear_registro_cliente_seguro`.

- [ ] **Step 1: Write the failing migration contract test**

Create `test/clientes-registration-migration.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const path =
  'creditek/erp/migrations/20260723_clientes_enlaces_seguros.sql';

test('migration is additive and creates the secure registration contract', async () => {
  const sql = await readFile(path, 'utf8');
  for (const required of [
    'create table if not exists public.captadores',
    'create table if not exists public.enlaces_registro',
    'create table if not exists public.documentos_solicitud',
    'add column if not exists captador_id',
    'add column if not exists enlace_registro_id',
    'create or replace function public.crear_registro_cliente_seguro',
  ]) {
    assert.ok(sql.toLowerCase().includes(required), `missing: ${required}`);
  }
  assert.doesNotMatch(sql.toLowerCase(), /\bdrop\s+(table|column|schema)\b/);
  assert.doesNotMatch(sql.toLowerCase(), /\btruncate\b/);
});
```

Run:

```bash
node --test test/clientes-registration-migration.test.mjs
```

Expected: FAIL with `ENOENT`.

- [ ] **Step 2: Create the additive migration**

Create `creditek/erp/migrations/20260723_clientes_enlaces_seguros.sql` with:

```sql
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
```

Before application, compare this function’s insert columns with live
`information_schema.columns`; adjust only for verified schema differences and
update this checked-in migration in the same commit.

- [ ] **Step 3: Verify the migration contract**

Run:

```bash
node --test test/clientes-registration-migration.test.mjs
git diff --check
```

Expected: test passes; no whitespace errors.

- [ ] **Step 4: Commit the migration**

```bash
git add creditek/erp/migrations/20260723_clientes_enlaces_seguros.sql \
  test/clientes-registration-migration.test.mjs
git commit -m "feat: add secure client registration schema"
```

---

### Task 3: Implement cryptographic tokens, sessions, OTPs, and image checks

**Files:**
- Create: `creditek/workers/creditek-clientes/src/registro-security.ts`
- Create: `creditek/workers/creditek-clientes/test/registro-security.spec.ts`
- Modify: `creditek/workers/creditek-clientes/src/index.ts`

**Interfaces:**
- Produces:
  - `generateOpaqueToken(bytes?: number): string`
  - `hashOpaqueToken(raw: string, secret: string): Promise<string>`
  - `generateOtp(): string`
  - `signSession(payload: SessionPayload, secret: string): Promise<string>`
  - `verifySession(token: string, secret: string, now?: number): Promise<SessionPayload>`
  - `detectImage(bytes: Uint8Array): 'image/jpeg' | 'image/png' | null`

- [ ] **Step 1: Write failing security tests**

Create `test/registro-security.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  detectImage,
  generateOpaqueToken,
  generateOtp,
  hashOpaqueToken,
  signSession,
  verifySession,
} from '../src/registro-security';

describe('secure registration primitives', () => {
  it('generates opaque non-enumerable tokens', () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(b).not.toBe(a);
  });

  it('hashes equal tokens equally and different tokens differently', async () => {
    await expect(hashOpaqueToken('uno', 'secreto')).resolves.toBe(
      await hashOpaqueToken('uno', 'secreto'),
    );
    expect(await hashOpaqueToken('uno', 'secreto')).not.toBe(
      await hashOpaqueToken('dos', 'secreto'),
    );
  });

  it('generates six-digit cryptographic OTPs', () => {
    expect(generateOtp()).toMatch(/^\\d{6}$/);
  });

  it('rejects expired or wrong-purpose sessions', async () => {
    const token = await signSession(
      {
        purpose: 'registro',
        cedula: '1066184151',
        celular: '3200000000',
        enlaceId: 'e1',
        otpId: 'o1',
        exp: 2_000,
      },
      'secreto',
    );
    await expect(verifySession(token, 'secreto', 2_001)).rejects.toThrow(
      'sesion_vencida',
    );
  });

  it('recognizes JPEG and PNG magic bytes only', () => {
    expect(detectImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe(
      'image/jpeg',
    );
    expect(
      detectImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe('image/png');
    expect(detectImage(new TextEncoder().encode('<script>'))).toBeNull();
  });
});
```

Run:

```bash
npm test -- registro-security.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement the security module**

Create `src/registro-security.ts` with Web Crypto:

```ts
export type SessionPurpose = 'registro' | 'documentos';

export interface SessionPayload {
  purpose: SessionPurpose;
  cedula: string;
  celular: string;
  enlaceId: string;
  otpId?: string;
  clienteId?: string;
  solicitudId?: string;
  exp: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function fromBase64url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
  );
}

export function generateOpaqueToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function hashOpaqueToken(
  raw: string,
  secret: string,
): Promise<string> {
  return base64url(await hmac(raw, secret));
}

export function generateOtp(): string {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return String(values[0] % 1_000_000).padStart(6, '0');
}

export async function signSession(
  payload: SessionPayload,
  secret: string,
): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  return `${body}.${base64url(await hmac(body, secret))}`;
}

export async function verifySession(
  token: string,
  secret: string,
  now = Date.now(),
): Promise<SessionPayload> {
  const [body, signature] = token.split('.');
  if (!body || !signature) throw new Error('sesion_invalida');
  const expected = base64url(await hmac(body, secret));
  if (expected !== signature) throw new Error('sesion_invalida');
  const payload = JSON.parse(decoder.decode(fromBase64url(body))) as SessionPayload;
  if (payload.exp < now) throw new Error('sesion_vencida');
  return payload;
}

export function detectImage(
  bytes: Uint8Array,
): 'image/jpeg' | 'image/png' | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((value, i) => bytes[i] === value)) {
    return 'image/png';
  }
  return null;
}
```

- [ ] **Step 3: Verify green and refactor without behavior changes**

Run:

```bash
npm test -- registro-security.spec.ts
npm run typecheck
```

Expected: all security tests pass and TypeScript exits 0.

- [ ] **Step 4: Commit the security primitives**

```bash
git add creditek/workers/creditek-clientes/src/registro-security.ts \
  creditek/workers/creditek-clientes/test/registro-security.spec.ts
git commit -m "feat: add secure registration tokens"
```

---

### Task 4: Resolve private links and enforce store-scoped captators

**Files:**
- Create: `creditek/workers/creditek-clientes/src/registro-context.ts`
- Create: `creditek/workers/creditek-clientes/test/registro-context.spec.ts`
- Modify: `creditek/workers/creditek-clientes/src/index.ts`
- Modify: `creditek/workers/creditek-clientes/wrangler.toml`

**Interfaces:**
- Consumes: `hashOpaqueToken`, Supabase REST, `TOKEN_HASH_SECRET`.
- Produces:
  - `GET /api/registro/contexto?t=<token>`
  - `resolveRegistrationContext(token, env, fetcher)`
  - `assertCaptadorAllowed(context, captadorId)`

- [ ] **Step 1: Write failing context tests**

The test must cover:

```ts
it('returns only the token store and its active captators');
it('rejects a revoked token');
it('rejects a captator from another store');
it('locks the captator for a personal link');
it('never returns the global origin catalog');
```

Use a fake `fetcher` that asserts the exact Supabase filters:

```ts
expect(request.url).toContain('token_hash=eq.');
expect(request.url).toContain('activo=eq.true');
expect(request.url).toContain('origen_codigo=eq.CK-01');
```

Run:

```bash
npm test -- registro-context.spec.ts
```

Expected: FAIL because `registro-context.ts` does not exist.

- [ ] **Step 2: Implement context resolution**

`resolveRegistrationContext` must:

1. reject tokens shorter than 32 characters;
2. HMAC-hash the token;
3. query one active, non-revoked `enlaces_registro` row;
4. query only the associated active origin;
5. query only active captators for that origin;
6. if `captador_id` is present, return only that captator;
7. return no phone, contact, other origin, token hash, or internal audit data.

Return shape:

```ts
export interface PublicRegistrationContext {
  enlaceId: string;
  tipo: 'tienda' | 'personal';
  origen: { codigo: string; nombre: string };
  captadores: Array<{ id: string; nombre: string }>;
}
```

- [ ] **Step 3: Add the public route and exact CORS**

Extend `Env`:

```ts
TOKEN_HASH_SECRET: string;
REGISTRATION_SIGNING_SECRET: string;
TURNSTILE_SITE_KEY: string;
TURNSTILE_SECRET_KEY: string;
ALLOWED_ORIGIN: string;
ALLOW_LEGACY_REGISTRATION_LINKS: string;
```

Add:

```ts
if (url.pathname === '/api/registro/contexto' && request.method === 'GET') {
  return await handleRegistroContexto(url, env);
}
```

Replace wildcard CORS with a function that only reflects
`env.ALLOWED_ORIGIN`. Do not send an allow-origin header for an unapproved
origin.

Add to `wrangler.toml`:

```toml
ALLOWED_ORIGIN = "https://registro.crediteksas.com"
ALLOW_LEGACY_REGISTRATION_LINKS = "true"
```

- [ ] **Step 4: Verify the context behavior**

Run:

```bash
npm test -- registro-context.spec.ts
npm test
npm run typecheck
```

Expected: all tests pass.

- [ ] **Step 5: Commit private context resolution**

```bash
git add creditek/workers/creditek-clientes/src/index.ts \
  creditek/workers/creditek-clientes/src/registro-context.ts \
  creditek/workers/creditek-clientes/test/registro-context.spec.ts \
  creditek/workers/creditek-clientes/wrangler.toml
git commit -m "feat: resolve private client registration links"
```

---

### Task 5: Bind Turnstile and one-time OTP verification to the registration

**Files:**
- Create: `creditek/workers/creditek-clientes/src/registro-otp.ts`
- Create: `creditek/workers/creditek-clientes/test/registro-otp.spec.ts`
- Modify: `creditek/workers/creditek-clientes/src/index.ts`

**Interfaces:**
- Consumes: resolved link, `generateOtp`, `hashOpaqueToken`, `signSession`,
  Supabase REST, WhatsApp template, Turnstile Siteverify.
- Produces:
  - public `GET /api/registro/config`;
  - secure `POST /api/otp/enviar`
  - secure `POST /api/otp/verificar`
  - one-time registration session.

- [ ] **Step 1: Write failing OTP tests**

Cover:

```ts
it('rejects OTP send when Turnstile validation fails');
it('binds OTP to cedula, phone, and registration link');
it('stores only codigo_hash for new OTPs');
it('limits sends by phone and registration link');
it('returns a signed registration session after a correct code');
it('rejects a session for a different cedula');
it('rejects an already-consumed OTP');
```

The Turnstile fake must verify a request to:

```text
https://challenges.cloudflare.com/turnstile/v0/siteverify
```

and return `{ success: true, hostname: 'registro.crediteksas.com' }`.

Run:

```bash
npm test -- registro-otp.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement mandatory server-side Turnstile validation**

Implement:

```ts
export async function verifyTurnstile(
  token: string,
  remoteIp: string | null,
  secret: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  if (!token) return false;
  const response = await fetcher(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret,
        response: token,
        remoteip: remoteIp,
        idempotency_key: crypto.randomUUID(),
      }),
    },
  );
  if (!response.ok) return false;
  const result = await response.json() as {
    success: boolean;
    hostname?: string;
  };
  return result.success === true &&
    result.hostname === 'registro.crediteksas.com';
}
```

Use Cloudflare’s published testing sitekey/secret in automated tests only.
Production `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` must be Worker
secrets. The public config route returns only this shape:

```ts
interface PublicRegistrationConfig {
  turnstile_site_key: string;
}
```

It must use exact-origin CORS and never return the secret key.

- [ ] **Step 3: Implement bound OTP storage and verification**

`/api/otp/enviar` must now require:

```json
{
  "enlace_token": "opaque",
  "cedula": "1066184151",
  "celular": "3200000000",
  "turnstile_token": "client-token"
}
```

Store:

```json
{
  "cedula": "1066184151",
  "celular": "3200000000",
  "enlace_registro_id": "uuid",
  "codigo_hash": "hmac",
  "expira_at": "server-time",
  "intentos": 0,
  "verificado": false
}
```

Do not store the plaintext code for new records. Verification returns a signed
`registro_session` with `purpose: "registro"` and 30-minute expiry.

- [ ] **Step 4: Verify OTP behavior**

Run:

```bash
npm test -- registro-otp.spec.ts
npm test
npm run typecheck
```

Expected: all tests pass.

- [ ] **Step 5: Commit secure OTP**

```bash
git add creditek/workers/creditek-clientes/src/index.ts \
  creditek/workers/creditek-clientes/src/registro-otp.ts \
  creditek/workers/creditek-clientes/test/registro-otp.spec.ts
git commit -m "feat: bind otp to secure client registration"
```

---

### Task 6: Make registration transactional and documents request-scoped

**Files:**
- Create: `creditek/workers/creditek-clientes/src/registro-submit.ts`
- Create: `creditek/workers/creditek-clientes/src/registro-documents.ts`
- Create: `creditek/workers/creditek-clientes/test/registro-submit.spec.ts`
- Create: `creditek/workers/creditek-clientes/test/registro-documents.spec.ts`
- Modify: `creditek/workers/creditek-clientes/src/index.ts`

**Interfaces:**
- Consumes: registration session, private-link context, captator catalog,
  RPC `crear_registro_cliente_seguro`.
- Produces: transactional `/api/registro`, temporary upload session, and
  `/api/documentos`.

- [ ] **Step 1: Write failing registration tests**

Cover:

```ts
it('rejects a seller from another store');
it('rejects a reused registration session');
it('derives origin and seller name on the server');
it('preserves the existing client first origin');
it('creates a new request for an existing client');
it('returns a document upload session bound to the request');
```

Run:

```bash
npm test -- registro-submit.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement registration through the RPC**

The public payload must not contain trusted `origen_codigo`,
`vendedor_nombre`, or `otp_ok`. It contains:

```ts
interface SecureRegistrationInput {
  enlace_token: string;
  captador_id: string;
  registro_session: string;
  nombre_completo: string;
  email?: string | null;
  ciudad: string;
  direccion: string;
  producto_interes: string;
  financiera?: string | null;
  referencias: Array<{
    nombre: string;
    telefono: string;
    parentesco?: string | null;
  }>;
  autorizacion_datos: true;
  autorizacion_comercial: boolean;
  autorizacion_version: string;
}
```

Pass the `otpId` from the verified registration session to the RPC as
`p_otp_id`. The RPC validates and consumes that OTP in the same database
transaction that creates the request. After it returns `cliente_id` and
`solicitud_id`, sign a 30-minute `documentos` session containing those IDs.
No separate OTP-consumption request is allowed.

- [ ] **Step 3: Write failing document tests**

Cover:

```ts
it('rejects files larger than four MiB');
it('rejects content whose magic bytes are not an image');
it('rejects an upload session for another request');
it('uses opaque paths without cedula');
it('upserts one document type per request');
it('keeps legacy latest-photo columns in sync');
```

Run:

```bash
npm test -- registro-documents.spec.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement request-scoped document uploads**

Use this path format:

```text
<cliente_uuid>/<solicitud_uuid>/<tipo>-<random_uuid>.jpg
```

Before upload:

1. verify the `documentos` session;
2. decode base64 with a hard four-MiB limit;
3. inspect magic bytes;
4. calculate SHA-256;
5. upload to the private `cedulas` bucket;
6. upsert `documentos_solicitud`;
7. update the matching latest-photo column in `clientes`.

`/api/subir-cedula` remains available only while
`ALLOW_LEGACY_REGISTRATION_LINKS=true`.

- [ ] **Step 5: Verify registration and documents**

Run:

```bash
npm test -- registro-submit.spec.ts registro-documents.spec.ts
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Expected: all tests and dry-run pass.

- [ ] **Step 6: Commit transactional registration**

```bash
git add creditek/workers/creditek-clientes/src \
  creditek/workers/creditek-clientes/test
git commit -m "feat: secure client registration and documents"
```

---

### Task 7: Update the public form and validation panel

**Files:**
- Modify: `creditek/erp/registro.html`
- Modify: `creditek/erp/validacion.html`
- Create: `test/clientes-registration-ui.test.mjs`

**Interfaces:**
- Consumes: `/api/registro/contexto`, secure OTP routes, secure registration,
  `/api/documentos`, and Turnstile sitekey.
- Produces: private-link-only public form and request-scoped validation view.

- [ ] **Step 1: Write failing static UI tests**

Create `test/clientes-registration-ui.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const registro = await readFile('creditek/erp/registro.html', 'utf8');
const validacion = await readFile('creditek/erp/validacion.html', 'utf8');

test('registration requires a private token and never renders the origin catalog', () => {
  assert.match(registro, /URLSearchParams\\(location\\.search\\).*get\\('t'\\)/s);
  assert.match(registro, /\\/api\\/registro\\/contexto/);
  assert.doesNotMatch(registro, /id="origenSelect"/);
  assert.doesNotMatch(registro, /ORIGENES_FALLBACK/);
});

test('registration uses scoped captators, address, Turnstile, and secure sessions', () => {
  assert.match(registro, /id="captadorSelect"/);
  assert.match(registro, /id="direccion"/);
  assert.match(registro, /turnstile\\.render/);
  assert.match(registro, /\\/api\\/registro\\/config/);
  assert.match(registro, /registro_session/);
  assert.match(registro, /\\/api\\/documentos/);
});

test('excluded financing fields are absent from client registration', () => {
  for (const id of ['valorFinanciado', 'numeroCuotas', 'valorCuota', 'tasaInteres']) {
    assert.doesNotMatch(registro, new RegExp(`id="${id}"`));
  }
});

test('validation prefers request-scoped documents with legacy fallback', () => {
  assert.match(validacion, /documentos_solicitud/);
  assert.match(validacion, /foto_cedula_frente_path/);
});
```

Run:

```bash
node --test test/clientes-registration-ui.test.mjs
```

Expected: FAIL because the old selector and fallback still exist.

- [ ] **Step 2: Replace origin selection with private context**

In `registro.html`:

- remove `origenSelect` and `ORIGENES_FALLBACK`;
- require `?t=`;
- call `/api/registro/contexto?t=...`;
- render one locked store name;
- render `captadorSelect` from the returned list;
- lock the only captator for personal links;
- show the invalid-link screen without loading the form.

- [ ] **Step 3: Add address and Turnstile**

Add the address field and Turnstile container:

```html
<div class="field">
  <label>Dirección <span class="req">*</span></label>
  <input
    type="text"
    id="direccion"
    placeholder="Dirección donde vive"
    autocomplete="street-address"
  >
</div>

<div id="turnstileContainer"></div>
```

Load the public sitekey from `/api/registro/config` and render explicitly:

```js
const configResponse = await fetch(`${API}/api/registro/config`);
const { turnstile_site_key: turnstileSiteKey } = await configResponse.json();
turnstile.render('#turnstileContainer', {
  sitekey: turnstileSiteKey,
  action: 'registro-cliente',
});
```

The sitekey is not hard-coded in HTML, and the secret key never reaches the
browser.

- [ ] **Step 4: Update OTP, registration, and document payloads**

Send the private token, cédula, and Turnstile token when requesting OTP. Keep
the returned `registro_session` only in memory. Send `captador_id`,
`direccion`, and `registro_session` when registering. Use the returned
`documentos_session` for all three photo uploads.

Never store either session in `localStorage` or `sessionStorage`.

- [ ] **Step 5: Update validation documents**

Modify the request query to include `documentos_solicitud(*)`. For each slot:

1. use the request-scoped document path when present;
2. fall back to the current client photo column;
3. continue generating five-minute signed URLs;
4. do not expose raw bucket paths outside the authenticated panel.

- [ ] **Step 6: Verify UI tests**

Run:

```bash
node --test test/clientes-registration-ui.test.mjs
node --test test/sofia-metricas-panel.test.mjs
git diff --check
```

Expected: all static tests pass.

- [ ] **Step 7: Commit the public and validation UI**

```bash
git add creditek/erp/registro.html creditek/erp/validacion.html \
  test/clientes-registration-ui.test.mjs
git commit -m "feat: use private links in client registration"
```

---

### Task 8: Seed captators and generate the 28 private links safely

**Files:**
- Create: `creditek/workers/creditek-clientes/scripts/seed-registration-links.mjs`
- Create: `creditek/workers/creditek-clientes/test/seed-registration-links.spec.ts`
- Modify externally after verification: Google Sheet `Links_Registro_Creditek`

**Interfaces:**
- Consumes: active `origenes`, active ERP profiles, verified contacts from the
  internal Google Sheet.
- Produces: one store link per active work origin and optional personal links.

- [ ] **Step 1: Write failing deterministic seed tests**

The test must prove:

```ts
it('creates one store link for each of the 28 work origins');
it('deduplicates captators by normalized name within one origin');
it('does not merge equal names from different origins');
it('stores token hashes but never raw tokens in Supabase payloads');
it('produces Creditek-domain URLs');
```

Run:

```bash
npm test -- seed-registration-links.spec.ts
```

Expected: FAIL because the script module does not exist.

- [ ] **Step 2: Implement seed planning and execution modes**

The script must support:

```bash
node scripts/seed-registration-links.mjs --dry-run
node scripts/seed-registration-links.mjs --apply --output /tmp/creditek-registration-links.json
```

Rules:

- `--dry-run` performs reads and prints only counts and origin codes.
- `--apply` requires `SUPABASE_SERVICE_KEY` and `TOKEN_HASH_SECRET`.
- Raw tokens are written only to the explicit `/tmp` output with mode `0600`.
- Console output never includes raw tokens or full links.
- Existing active store links are not duplicated.
- The output contains `{ codigo, nombre, link }` for Drive update.

- [ ] **Step 3: Verify all 28 planned mappings**

Compare:

- 10 own stores;
- 18 allies;
- the 28 codes currently in `Links_Registro_Creditek`;
- active `origenes` in Supabase.

Treat `CENTRAL` as an internal origin and do not generate a public client link
unless the approved spreadsheet explicitly adds it later.

- [ ] **Step 4: Commit the seed tooling**

```bash
git add creditek/workers/creditek-clientes/scripts \
  creditek/workers/creditek-clientes/test/seed-registration-links.spec.ts
git commit -m "feat: generate private client registration links"
```

---

### Task 9: Provision, deploy, verify, and start the seven-day transition

**Files:**
- Modify: `docs/superpowers/plans/2026-07-23-clientes-enlaces-seguros.md`
  only to mark completed checkboxes and record non-secret version IDs.
- Modify externally: Cloudflare Turnstile widget and Worker secrets.
- Modify externally: Supabase additive schema and seed rows.
- Modify externally: Google Sheet link column.

**Interfaces:**
- Produces: live secure registration, verified 28-link inventory, and an exact
  rollback record.

- [ ] **Step 1: Run the complete local verification**

Run from the worktree:

```bash
node --test test/clientes-registration-migration.test.mjs
node --test test/clientes-registration-ui.test.mjs
node --test test/sofia-metricas-panel.test.mjs
cd creditek/workers/creditek-clientes
npm test
npm run typecheck
npm audit
npx wrangler deploy --dry-run
git diff --check
git status --short --branch
```

Expected: zero failures, zero known vulnerabilities, clean diff checks.

- [ ] **Step 2: Record production rollback points**

Record without exposing secrets:

```bash
npx wrangler versions list
git rev-parse origin/main
```

Save:

- current `creditek-clientes` version ID;
- current static-site commit;
- current Supabase migration state;
- Google Sheet revision timestamp.

- [ ] **Step 3: Create the Turnstile widget**

Create widget `Creditek Registro Clientes` in Cloudflare with hostname:

```text
registro.crediteksas.com
```

Use managed mode. Store both keys in the Worker environment; only the public
one is returned by `/api/registro/config`:

```bash
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

Use Cloudflare testing keys locally; never allow localhost on the production
widget.

- [ ] **Step 4: Store signing secrets**

Generate two independent 48-byte secrets and pipe them directly to Wrangler:

```bash
openssl rand -base64 48 | npx wrangler secret put TOKEN_HASH_SECRET
openssl rand -base64 48 | npx wrangler secret put REGISTRATION_SIGNING_SECRET
```

Do not print, copy into a document, or store these values in shell history.

- [ ] **Step 5: Back up and apply the Supabase migration**

Take a restorable backup of `creditek-erp`. Confirm the backup timestamp and
size. Run the checked-in migration once. Verify with read-only queries:

```sql
select to_regclass('public.captadores');
select to_regclass('public.enlaces_registro');
select to_regclass('public.documentos_solicitud');
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'solicitudes'
  and column_name in ('captador_id', 'enlace_registro_id');
```

Expected: all three tables and both columns exist.

- [ ] **Step 6: Seed captators and links**

Run dry-run, inspect counts, then apply. Expected:

```text
28 public store origins
28 private store links
0 raw tokens printed
CENTRAL excluded
```

- [ ] **Step 7: Deploy Worker first**

Deploy `creditek-clientes` with legacy compatibility still enabled:

```bash
npx wrangler deploy
```

Verify:

- `/api/registro/contexto` rejects missing tokens;
- one own-store token resolves one store;
- one ally token resolves one ally;
- `/api/origenes` remains available only for the seven-day legacy path;
- cron triggers are unchanged;
- no new errors appear in a bounded production tail.

- [ ] **Step 8: Push and deploy the static form**

Push the implementation branch through the established repository workflow.
Verify the public generic URL shows the invalid-link screen. Verify one own
store and one ally link on a real mobile viewport without submitting customer
data.

- [ ] **Step 9: Perform two controlled end-to-end registrations**

With explicit test identities:

1. own store;
2. ally.

Verify:

- OTP arrives and cannot be reused;
- store and captator are correct;
- customer/request are created once;
- three documents attach to the request;
- validation panel displays the correct records;
- no financing amount, installment, or interest field was introduced.

- [ ] **Step 10: Update the Google Sheet**

Read the exact current `Links_Registro_Creditek` range before writing. Update
only column `LINK DE REGISTRO` for the 28 existing rows. Do not alter codes,
contacts, phones, executives, formatting, sharing, or the `CENTRAL` omission.
Read back all 28 links and verify they use:

```text
https://registro.crediteksas.com/creditek/erp/registro?t=
```

- [ ] **Step 11: Start and document the seven-day transition**

Record:

- start date/time in `America/Bogota`;
- end date/time exactly seven calendar days later;
- person responsible for distributing links;
- link verification result.

After the window, set:

```toml
ALLOW_LEGACY_REGISTRATION_LINKS = "false"
```

Deploy the Worker and verify:

- `?origen=` no longer initializes a registration;
- `/api/origenes` no longer exposes the catalog;
- all 28 private links remain active.

- [ ] **Step 12: Final verification and handoff**

Run fresh:

```bash
npm test
npm run typecheck
npx wrangler deploy --dry-run
node --test test/clientes-registration-migration.test.mjs
node --test test/clientes-registration-ui.test.mjs
git status --short --branch
```

Report:

- test counts;
- active Worker version;
- previous Worker rollback version;
- static-site commit;
- migration applied;
- 28/28 links verified;
- two controlled registrations verified;
- no changes to Sofía, sales, credits, or portfolio.
