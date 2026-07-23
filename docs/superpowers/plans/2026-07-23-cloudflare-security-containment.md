# CREDITEK Cloudflare Security Containment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove server-side credentials and internal source files from CREDITEK's public surfaces, make the GitHub repository private, preserve automatic Cloudflare deployments, and rotate the exposed Portal and Gemini credentials without interrupting production.

**Architecture:** Build an explicit `public/` artifact from a narrow allowlist instead of deploying the repository root. Upload and test a Cloudflare preview before promoting it, then make GitHub private and verify the private build integration. Rotate credentials with overlap: install and verify replacements before revoking compromised values.

**Tech Stack:** Node.js 20.11+, Node built-in test runner, Wrangler 4.114.0, Cloudflare Workers Static Assets, GitHub CLI, agent-browser, Google Apps Script, Google Workload Identity Federation.

## Global Constraints

- Keep every existing public URL functional throughout the phase.
- Do not modify ERP or Sofía application behavior.
- Do not disable or migrate any Google Apps Script in this phase.
- Do not stop or edit existing Cloudflare Cron Triggers.
- Do not revoke an exposed credential before its replacement works.
- Do not expose secret values in logs, documentation, commits, shell history, or chat.
- Stop at the first failed validation and restore the last verified state.
- Legacy browser-shared credentials remain documented findings until their dedicated Worker replacements exist.
- No DNS changes are permitted in this phase.

---

## File Structure

- `scripts/build-public.mjs`: creates the only directory Wrangler may publish.
- `scripts/verify-public-artifact.mjs`: rejects server files, private keys, unsafe symlinks, and unexpected files.
- `tests/security/build-public.test.mjs`: proves the allowlist keeps required applications and excludes backend material.
- `tests/security/live-smoke.test.mjs`: performs read-only checks against a supplied base URL.
- `tests/security/gemini-jwks.test.mjs`: validates single-key and dual-key JWKS parsing.
- `wrangler.jsonc`: pins the `consultora` Worker and its `public/` asset directory.
- `package.json`: exposes reproducible build, test, preview, and deploy commands.
- `.gitignore`: excludes generated `public/` output.
- `creditek/workers/gemini-proxy/index.js`: supports a dual-key JWKS transition.
- `creditek/workers/gemini-proxy/wif-private.pem`: removed from the current Git tree after the new key works; historical copies remain compromised.

---

### Task 1: Capture the Production Baseline

**Files:**
- Create: `tests/security/live-smoke.test.mjs`
- Create: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: environment variable `BASE_URL`, defaulting to `https://registro.crediteksas.com`.
- Produces: a repeatable read-only smoke suite and a baseline record containing no secrets.

- [ ] **Step 1: Write the live smoke test**

Create `tests/security/live-smoke.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const base = (process.env.BASE_URL || 'https://registro.crediteksas.com').replace(/\/$/, '');

const entrypoints = [
  ['/creditek/agentes/', 'CREDITEK'],
  ['/creditek/agentes/creditek-agente-redes.html', 'Agente'],
  ['/creditek/agentes/creditek-agente-respuestas.html', 'Sofía'],
  ['/creditek/agentes/agente3-meta-ads.html', 'Meta Ads'],
  ['/creditek/agentes/creditek-agente-calendario.html', 'Calendario'],
  ['/creditek/portal/', 'Portal de Pedidos'],
  ['/creditek/agentes/creditek-gbp-fichas.html', 'Google Business'],
  ['/creditek/convenios/', 'Convenio'],
];

for (const [path, expectedText] of entrypoints) {
  test(`GET ${path} remains available`, async () => {
    const response = await fetch(`${base}${path}`, { redirect: 'follow' });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, new RegExp(expectedText, 'i'));
  });
}

test('internal Apps Script source is not public', async () => {
  const response = await fetch(`${base}/creditek/portal/Code.gs`, { redirect: 'manual' });
  assert.equal(response.status, 404);
});

test('Gemini private key is not public', async () => {
  const response = await fetch(
    `${base}/creditek/workers/gemini-proxy/wif-private.pem`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 404);
});
```

- [ ] **Step 2: Run the baseline and confirm the security checks fail**

Run:

```bash
node --test tests/security/live-smoke.test.mjs
```

Expected:

- The eight application availability tests pass.
- At least one of the two internal-file tests fails because the current production deployment exposes internal material.
- No form is submitted and no API mutation is performed.

- [ ] **Step 3: Record Cloudflare and GitHub state**

Run these read-only commands and record only identifiers, status, and schedule expressions:

```bash
git rev-parse HEAD
gh repo view oscarjp88-arch/consultora --json visibility,defaultBranchRef,url
cd creditek/workers/gemini-proxy && npx wrangler deployments list
cd ../creditek-clientes && npx wrangler deployments list
cd ../pdf-combiner && npx wrangler deployments list
```

Use the Cloudflare dashboard to record the active `consultora` version ID and
the existing Cron Trigger expressions for `creditek-bot` and
`creditek-clientes`. Do not open secret values.

Create `docs/security/cloudflare-containment-baseline.md` with:

```markdown
# Cloudflare containment baseline

- Captured at: value returned by `date -u +%Y-%m-%dT%H:%M:%SZ`
- Git commit: value returned by `git rev-parse HEAD`
- GitHub visibility: PUBLIC
- Consultora active version: exact identifier copied from Cloudflare Version History
- Public application checks: 8/8 available
- Internal Apps Script source: exposed
- Gemini private key path: exposed or tracked
- Existing Cron Triggers: recorded; unchanged by this phase
- Portal Google Apps Script: active
- Convenios Google Apps Script: active
```

The angle-bracket values are operational evidence gathered during execution,
not secret values.

- [ ] **Step 4: Commit the baseline test and evidence**

```bash
git add tests/security/live-smoke.test.mjs docs/security/cloudflare-containment-baseline.md
git commit -m "test: capture Cloudflare containment baseline"
```

---

### Task 2: Build a Strict Public Artifact

**Files:**
- Create: `tests/security/build-public.test.mjs`
- Create: `scripts/build-public.mjs`
- Create: `scripts/verify-public-artifact.mjs`
- Create: `wrangler.jsonc`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: tracked public files under `index.html` and selected `creditek/` paths.
- Produces: `public/`, containing only deployable client assets; functions `buildPublic(rootDir, outDir)` and `verifyPublicArtifact(outDir)`.

- [ ] **Step 1: Write the failing artifact test**

Create `tests/security/build-public.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPublic } from '../../scripts/build-public.mjs';
import { verifyPublicArtifact } from '../../scripts/verify-public-artifact.mjs';

const root = path.resolve(import.meta.dirname, '../..');

test('build keeps required public applications and excludes backend source', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'creditek-public-'));
  await buildPublic(root, out);
  await verifyPublicArtifact(out);

  const required = [
    'creditek/agentes/index.html',
    'creditek/agentes/creditek-agente-redes.html',
    'creditek/agentes/creditek-agente-respuestas.html',
    'creditek/agentes/agente3-meta-ads.html',
    'creditek/agentes/creditek-agente-calendario.html',
    'creditek/portal/index.html',
    'creditek/agentes/creditek-gbp-fichas.html',
    'creditek/convenios/index.html',
    'creditek/erp/app.html',
    'creditek/legal/index.html',
  ];

  for (const relative of required) {
    assert.equal((await stat(path.join(out, relative))).isFile(), true, relative);
  }

  const portalHtml = await readFile(path.join(out, 'creditek/portal/index.html'), 'utf8');
  assert.match(portalHtml, /Portal de Pedidos/i);
});

test('build does not publish known server-only paths', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'creditek-public-'));
  await buildPublic(root, out);

  const forbidden = [
    'creditek/portal/Code.gs',
    'creditek/workers/gemini-proxy/wif-private.pem',
    'creditek/workers/gemini-proxy/index.js',
    'creditek/erp/scripts/crear_admins.mjs',
    'creditek/erp/tests/smoke_test_bodega_central_v1.sql',
  ];

  for (const relative of forbidden) {
    await assert.rejects(stat(path.join(out, relative)), { code: 'ENOENT' });
  }
});
```

- [ ] **Step 2: Run the test and confirm it fails because the build modules do not exist**

```bash
node --test tests/security/build-public.test.mjs
```

Expected: `ERR_MODULE_NOT_FOUND` for `scripts/build-public.mjs`.

- [ ] **Step 3: Implement the allowlisted build**

Create `scripts/build-public.mjs`:

```js
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_TREES = [
  'creditek/agentes',
  'creditek/assets',
  'creditek/data',
];

const PUBLIC_FILES = [
  'index.html',
  'creditek/convenios/index.html',
  'creditek/legal/index.html',
  'creditek/portal/index.html',
];

const ERP_EXTENSIONS = new Set(['.html', '.js']);

async function copyFileFromRoot(rootDir, outDir, relative) {
  const source = path.join(rootDir, relative);
  const destination = path.join(outDir, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination);
}

export async function buildPublic(rootDir, outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (const relative of PUBLIC_FILES) {
    await copyFileFromRoot(rootDir, outDir, relative);
  }

  for (const relative of PUBLIC_TREES) {
    await cp(path.join(rootDir, relative), path.join(outDir, relative), {
      recursive: true,
      filter: source => !path.basename(source).startsWith('.'),
    });
  }

  const erpDir = path.join(rootDir, 'creditek/erp');
  for (const entry of await readdir(erpDir)) {
    const source = path.join(erpDir, entry);
    if (!(await stat(source)).isFile()) continue;
    if (!ERP_EXTENSIONS.has(path.extname(entry))) continue;
    await copyFileFromRoot(rootDir, outDir, `creditek/erp/${entry}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(import.meta.dirname, '..');
  await buildPublic(rootDir, path.join(rootDir, 'public'));
}
```

- [ ] **Step 4: Implement artifact verification**

Create `scripts/verify-public-artifact.mjs`:

```js
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_EXTENSIONS = new Set([
  '.env', '.gs', '.pem', '.sql', '.toml', '.log', '.bak', '.py',
]);
const FORBIDDEN_NAMES = new Set([
  'credentials.json', 'token.json', 'package.json', 'package-lock.json',
  'wrangler.jsonc', 'wrangler.toml',
]);
const FORBIDDEN_CONTENT = [
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
  /\bWA_ACCESS_TOKEN\s*:/,
  /\bGCP_WIF_PRIVATE_KEY\s*=/,
];

async function walk(root, current = root) {
  const files = [];
  for (const entry of await readdir(current)) {
    const absolute = path.join(current, entry);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symlink forbidden: ${absolute}`);
    if (info.isDirectory()) files.push(...await walk(root, absolute));
    else files.push(absolute);
  }
  return files;
}

export async function verifyPublicArtifact(outDir) {
  for (const file of await walk(outDir)) {
    const name = path.basename(file);
    const extension = path.extname(name).toLowerCase();
    if (FORBIDDEN_NAMES.has(name) || FORBIDDEN_EXTENSIONS.has(extension)) {
      throw new Error(`Server-only file in public artifact: ${path.relative(outDir, file)}`);
    }
    if (['.html', '.js', '.json', '.txt'].includes(extension)) {
      const content = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_CONTENT) {
        if (pattern.test(content)) {
          throw new Error(`Server-only credential pattern in ${path.relative(outDir, file)}`);
        }
      }
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifyPublicArtifact(path.resolve(import.meta.dirname, '../public'));
}
```

- [ ] **Step 5: Add reproducible Cloudflare configuration**

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "consultora",
  "compatibility_date": "2026-07-23",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "./public"
  }
}
```

Update `package.json` scripts and development dependencies:

```json
{
  "scripts": {
    "build": "node scripts/build-public.mjs && node scripts/verify-public-artifact.mjs",
    "test": "node --test tests/security/*.test.mjs",
    "test:live": "node --test tests/security/live-smoke.test.mjs",
    "preview:upload": "npm run build && wrangler versions upload",
    "deploy": "npm run build && wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "4.114.0"
  }
}
```

Preserve the existing runtime dependencies and other package metadata.

Append to `.gitignore`:

```gitignore

# Generated Cloudflare static artifact
public/
.wrangler/
```

Run:

```bash
npm install --package-lock-only
```

- [ ] **Step 6: Run build and tests**

```bash
npm run build
node --test tests/security/build-public.test.mjs
```

Expected: all artifact tests pass and `public/` contains no forbidden file.

- [ ] **Step 7: Verify the generated artifact has no unexpected GitHub or server paths**

```bash
find public -type f | sort
test ! -e public/creditek/portal/Code.gs
test ! -e public/creditek/workers/gemini-proxy/wif-private.pem
rg -l --hidden 'BEGIN (RSA )?PRIVATE KEY|WA_ACCESS_TOKEN\\s*:|GCP_WIF_PRIVATE_KEY\\s*=' public && exit 1 || true
```

Expected: the two `test` commands succeed and `rg` prints no matching file.

- [ ] **Step 8: Commit the strict artifact pipeline**

```bash
git add package.json package-lock.json .gitignore wrangler.jsonc scripts tests/security/build-public.test.mjs
git commit -m "build: publish strict Cloudflare asset allowlist"
```

---

### Task 3: Add a Safe Gemini Dual-Key Transition

**Files:**
- Create: `tests/security/gemini-jwks.test.mjs`
- Modify: `creditek/workers/gemini-proxy/index.js`

**Interfaces:**
- Consumes: `GCP_WIF_PUBLIC_JWK` containing either one JWK object or a JWK Set `{ "keys": [...] }`; optional `GCP_WIF_KEY_ID`.
- Produces: `parsePublicJwks(raw)` and JWT signatures whose `kid` matches `GCP_WIF_KEY_ID`.

- [ ] **Step 1: Write failing JWKS parsing tests**

Create `tests/security/gemini-jwks.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicJwks } from '../../creditek/workers/gemini-proxy/index.js';

const oldKey = { kty: 'RSA', kid: 'creditek-key-1', n: 'old', e: 'AQAB' };
const newKey = { kty: 'RSA', kid: 'creditek-key-2', n: 'new', e: 'AQAB' };

test('accepts the legacy single JWK format', () => {
  assert.deepEqual(parsePublicJwks(JSON.stringify(oldKey)), [oldKey]);
});

test('accepts a dual-key JWK Set during rotation', () => {
  assert.deepEqual(
    parsePublicJwks(JSON.stringify({ keys: [oldKey, newKey] })),
    [oldKey, newKey],
  );
});

test('rejects an empty or malformed JWK configuration', () => {
  assert.throws(() => parsePublicJwks(''), /missing/i);
  assert.throws(() => parsePublicJwks('{"keys":[]}'), /at least one/i);
});
```

- [ ] **Step 2: Run the test and confirm the export is missing**

```bash
node --test tests/security/gemini-jwks.test.mjs
```

Expected: fail because `parsePublicJwks` is not exported.

- [ ] **Step 3: Implement dual-key parsing and configurable `kid`**

Add near the top of `creditek/workers/gemini-proxy/index.js`:

```js
export function parsePublicJwks(raw) {
  if (!raw) throw new Error('GCP WIF public JWK is missing');
  const parsed = JSON.parse(raw);
  const keys = Array.isArray(parsed?.keys) ? parsed.keys : [parsed];
  if (keys.length === 0) throw new Error('JWKS requires at least one key');
  return keys;
}
```

Change:

```js
async function signJwt(privateKeyPem, payload) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'creditek-key-1' };
```

to:

```js
async function signJwt(privateKeyPem, payload, keyId = 'creditek-key-1') {
  const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
```

Change the call in `getVertexToken(env)` to:

```js
  const jwt = await signJwt(env.GCP_WIF_PRIVATE_KEY, {
    iss: WORKER_URL,
    sub: 'creditek-worker',
    aud: WORKER_URL,
    iat: now,
    exp: now + 3600,
  }, env.GCP_WIF_KEY_ID || 'creditek-key-1');
```

Change the JWKS endpoint to:

```js
    if (path === '/.well-known/jwks.json') {
      const keys = parsePublicJwks(env.GCP_WIF_PUBLIC_JWK);
      return new Response(JSON.stringify({ keys }), {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }
```

- [ ] **Step 4: Run all local security tests**

```bash
npm test
```

Expected: artifact and JWKS tests pass; live internal-file tests remain failing until deployment.

- [ ] **Step 5: Validate the Gemini Worker without deploying**

```bash
cd creditek/workers/gemini-proxy
npx wrangler deploy --dry-run
```

Expected: Wrangler exits `0` and reports a successful bundle without uploading.

- [ ] **Step 6: Commit dual-key support**

```bash
git add creditek/workers/gemini-proxy/index.js tests/security/gemini-jwks.test.mjs
git commit -m "security: support zero-downtime Gemini key rotation"
```

---

### Task 4: Upload and Test Cloudflare Preview Versions

**Files:**
- Modify: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: the strict `public/` artifact and Gemini dual-key Worker bundle.
- Produces: preview version IDs and read-only verification evidence; no active deployment changes.

- [ ] **Step 1: Upload a non-production `consultora` version**

```bash
npm run preview:upload
```

Expected: Wrangler returns a new version ID and preview URL but does not promote it.

Record both values in the baseline document.

- [ ] **Step 2: Run the full smoke test against the preview URL**

```bash
export BASE_URL
node --test tests/security/live-smoke.test.mjs
```

Before running the command, set `BASE_URL` interactively to the exact preview
URL returned by Wrangler; do not type it into a committed file. Expected: all
ten tests pass, including both internal-file `404` assertions.

- [ ] **Step 3: Upload a non-production Gemini proxy version**

```bash
cd creditek/workers/gemini-proxy
npx wrangler versions upload
```

Expected: a version ID is created without replacing the active Worker.

- [ ] **Step 4: Verify the Gemini preview**

Against the exact preview URL:

```bash
export GEMINI_PREVIEW_URL
curl --fail --silent "$GEMINI_PREVIEW_URL/health" | jq -e '.ok == true and .wif == true and .jwks == true'
curl --fail --silent "$GEMINI_PREVIEW_URL/.well-known/jwks.json" | jq -e '.keys | length >= 1'
```

Set `GEMINI_PREVIEW_URL` interactively to the exact preview URL returned by
Wrangler. Expected: both commands exit `0`. Do not perform image generation
yet because the current WIF issuer is the production Worker URL.

- [ ] **Step 5: Stop if any preview check fails**

Do not promote either version. Record the failure and repair only the local
artifact or preview configuration, then repeat this task.

---

### Task 5: Deploy Containment and Verify Production

**Files:**
- Modify: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: the verified `consultora` preview version.
- Produces: a production static deployment with unchanged application URLs and inaccessible internal files.

- [ ] **Step 1: Preserve rollback identifiers**

Use the Cloudflare dashboard to copy the active production version ID for
`consultora` into the baseline document. Do not delete it.

- [ ] **Step 2: Deploy the verified static artifact**

```bash
npm run deploy
```

Expected: Wrangler exits `0`, deploys Worker `consultora`, and reports the
existing custom domain without a DNS change.

- [ ] **Step 3: Run fresh production smoke tests**

```bash
BASE_URL='https://registro.crediteksas.com' node --test tests/security/live-smoke.test.mjs
```

Expected: ten tests pass.

- [ ] **Step 4: Confirm current automation remains configured**

In the Cloudflare dashboard, compare the recorded Cron Trigger expressions for
`creditek-bot` and `creditek-clientes` with the baseline. They must be
identical. Check that their latest execution timestamps continue advancing.

- [ ] **Step 5: Roll back on an application regression**

If an application availability or asset check fails, use Cloudflare Version
History to redeploy the baseline `consultora` version. Then confirm the eight
application availability tests pass before repairing the strict artifact.

- [ ] **Step 6: Commit production evidence**

Update the baseline document with the new version ID and test summary:

```bash
git add docs/security/cloudflare-containment-baseline.md
git commit -m "docs: record Cloudflare containment deployment"
```

---

### Task 6: Make GitHub Private and Restore Automatic Builds

**Files:**
- No application source changes.
- Modify: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: verified production and the existing Cloudflare GitHub integration.
- Produces: private repository visibility and one successful automatic Cloudflare build.

- [ ] **Step 1: Confirm production is independent of the next change**

```bash
curl --fail --silent --output /dev/null https://registro.crediteksas.com/creditek/agentes/
```

Expected: exit `0`.

- [ ] **Step 2: Change repository visibility**

```bash
gh repo edit oscarjp88-arch/consultora \
  --visibility private \
  --accept-visibility-change-consequences
```

- [ ] **Step 3: Verify private visibility**

```bash
gh repo view oscarjp88-arch/consultora --json visibility --jq '.visibility'
```

Expected: `PRIVATE`.

- [ ] **Step 4: Grant Cloudflare access to the private repository**

In GitHub application settings, configure the Cloudflare Workers & Pages
application for selected repositories and select only
`oscarjp88-arch/consultora`.

In Cloudflare `consultora` → Settings → Builds, verify that the repository and
production branch `main` remain selected. If access is missing, reconnect the
same repository; do not create a second Worker.

- [ ] **Step 5: Push the verified commits**

Before pushing:

```bash
npm test
git status --short
git log --oneline origin/main..HEAD
```

Expected: security tests pass except no live mutation tests; only intentional
commits are ahead of `origin/main`; unrelated untracked user files remain
unstaged.

Then:

```bash
git push origin main
```

- [ ] **Step 6: Verify the private automatic build**

In Cloudflare build history, wait for the pushed commit to reach `Success`.
Confirm the resulting version is active, then run:

```bash
BASE_URL='https://registro.crediteksas.com' node --test tests/security/live-smoke.test.mjs
```

Expected: ten tests pass.

- [ ] **Step 7: Record the private-build evidence**

Add the GitHub visibility, successful Cloudflare build ID, commit hash, and
verification timestamp to the baseline document, then commit:

```bash
git add docs/security/cloudflare-containment-baseline.md
git commit -m "docs: verify private GitHub Cloudflare build"
```

---

### Task 7: Rotate the Gemini WIF Key Without Downtime

**Files:**
- Delete after successful rotation: `creditek/workers/gemini-proxy/wif-private.pem`
- Modify: `.gitignore`
- Modify: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: dual-key JWKS support deployed to `creditek-gemini-proxy`.
- Produces: new `creditek-key-2` signing key, old key removal, and a working Vertex AI image path.

- [ ] **Step 1: Deploy dual-key-capable code with current secrets**

```bash
cd creditek/workers/gemini-proxy
npx wrangler deploy
curl --fail --silent https://creditek-gemini-proxy.comercial-853.workers.dev/health | jq -e '.ok == true'
```

Expected: deploy succeeds and health remains true.

- [ ] **Step 2: Generate a new keypair outside the repository**

Use a temporary directory:

```bash
ROTATION_DIR="$(mktemp -d)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$ROTATION_DIR/private.pem"
openssl pkey -in "$ROTATION_DIR/private.pem" -pubout -out "$ROTATION_DIR/public.pem"
```

Do not print either key and do not copy them into the repository.

- [ ] **Step 3: Convert only the new public key to JWK**

Use Node's built-in cryptography module to read only the new public key and
write `new-public.jwk.json` inside `$ROTATION_DIR`:

```bash
node -e 'const fs=require("node:fs");const crypto=require("node:crypto");const source=fs.readFileSync(process.argv[1],"utf8");const jwk=crypto.createPublicKey(source).export({format:"jwk"});Object.assign(jwk,{kid:"creditek-key-2",alg:"RS256",use:"sig"});fs.writeFileSync(process.argv[2],JSON.stringify(jwk));' \
  "$ROTATION_DIR/public.pem" \
  "$ROTATION_DIR/new-public.jwk.json"
jq '{kty, kid, alg, use, has_n: has("n"), has_e: has("e")}' "$ROTATION_DIR/new-public.jwk.json"
```

Expected: RSA signing JWK with `kid` `creditek-key-2`, `n`, and `e`.

- [ ] **Step 4: Publish both public keys**

Download the current public JWK from the public JWKS endpoint and combine it
with the new public JWK. Public JWK values verify signatures and are not private
key material:

```bash
curl --fail --silent \
  https://creditek-gemini-proxy.comercial-853.workers.dev/.well-known/jwks.json \
  | jq -e '.keys[0]' > "$ROTATION_DIR/current-public.jwk.json"
jq -s '{keys: .}' \
  "$ROTATION_DIR/current-public.jwk.json" \
  "$ROTATION_DIR/new-public.jwk.json" \
  > "$ROTATION_DIR/dual-public.jwks.json"
jq -e '[.keys[].kid] | sort == ["creditek-key-1","creditek-key-2"]' \
  "$ROTATION_DIR/dual-public.jwks.json"
```

Install the JWK Set without printing it:

```bash
npx wrangler secret put GCP_WIF_PUBLIC_JWK < "$ROTATION_DIR/dual-public.jwks.json"
```

Then verify:

```bash
curl --fail --silent \
  https://creditek-gemini-proxy.comercial-853.workers.dev/.well-known/jwks.json \
  | jq -e '[.keys[].kid] | sort == ["creditek-key-1","creditek-key-2"]'
```

- [ ] **Step 5: Switch signing to the new key**

Install the new private key and key ID without command-line exposure:

```bash
npx wrangler secret put GCP_WIF_PRIVATE_KEY < "$ROTATION_DIR/private.pem"
printf '%s' 'creditek-key-2' | npx wrangler secret put GCP_WIF_KEY_ID
```

- [ ] **Step 6: Perform the approved end-to-end Gemini test**

Use the existing authenticated Agent 1 image-generation flow with a harmless
test prompt and verify that:

- `/generate` returns success.
- The response contains an image.
- No fallback API key path was used.
- Existing Agent 1 behavior remains unchanged.

If this fails, restore the old private-key secret and `GCP_WIF_KEY_ID` before
changing the JWKS.

- [ ] **Step 7: Remove the old public key**

After the new key succeeds and Google JWKS caches have refreshed, replace
`GCP_WIF_PUBLIC_JWK` with only the `creditek-key-2` public JWK and verify:

```bash
curl --fail --silent \
  https://creditek-gemini-proxy.comercial-853.workers.dev/.well-known/jwks.json \
  | jq -e '[.keys[].kid] == ["creditek-key-2"]'
```

Repeat the approved image-generation test.

- [ ] **Step 8: Remove the tracked private key from the current tree**

Append to `.gitignore`:

```gitignore

# Private key material must never be versioned
*.pem
*.key
*.jwk.json
```

Remove only the tracked key:

```bash
git rm creditek/workers/gemini-proxy/wif-private.pem
git add .gitignore docs/security/cloudflare-containment-baseline.md
git commit -m "security: rotate Gemini WIF signing key"
```

Record the rotation timestamp and key IDs only, never key material.

- [ ] **Step 9: Securely delete the temporary rotation directory**

Move the temporary directory to the operating system Trash or use the approved
secure cleanup workflow after confirming Cloudflare contains the new secrets.
Do not use a broad or unresolved path.

---

### Task 8: Rotate the Portal WhatsApp Credential Safely

**Files:**
- Modify: `creditek/portal/Code.gs`
- Modify: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: a new CREDITEK-owned Meta system-user/Page token.
- Produces: Apps Script property `WA_ACCESS_TOKEN`; no token literal in source.

- [ ] **Step 1: Add a local static test before editing Apps Script source**

Create `tests/security/portal-apps-script.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(
  new URL('../../creditek/portal/Code.gs', import.meta.url),
  'utf8',
);

test('Portal backend reads WhatsApp token from Script Properties', () => {
  assert.match(source, /PropertiesService\.getScriptProperties\(\)/);
  assert.match(source, /getProperty\(['"]WA_ACCESS_TOKEN['"]\)/);
});

test('Portal backend contains no literal Meta access token', () => {
  assert.doesNotMatch(source, /\bEAA[A-Za-z0-9]{40,}/);
});
```

- [ ] **Step 2: Run the test and confirm it fails on the literal token**

```bash
node --test tests/security/portal-apps-script.test.mjs
```

Expected: both assertions fail on the current source.

- [ ] **Step 3: Replace the source literal with Script Properties**

In `creditek/portal/Code.gs`, define:

```js
var SCRIPT_PROPERTIES = PropertiesService.getScriptProperties();

var CONFIG = {
  WA_ACCESS_TOKEN: SCRIPT_PROPERTIES.getProperty('WA_ACCESS_TOKEN'),
```

Preserve the remaining `CONFIG` fields unchanged.

- [ ] **Step 4: Run the static security test**

```bash
node --test tests/security/portal-apps-script.test.mjs
```

Expected: both tests pass.

- [ ] **Step 5: Create the replacement Meta credential**

In Meta Business Manager, create or use a CREDITEK-owned system user, assign
only the Page/WhatsApp assets required by Portal B2B, and generate a replacement
token. Do not use Jennifer's personal account and do not paste the token into
chat, Git, or a command argument.

- [ ] **Step 6: Install the new token in Apps Script before revoking the old token**

In the active Portal B2B Apps Script project:

1. Open Project Settings → Script Properties.
2. Add `WA_ACCESS_TOKEN`.
3. Paste the replacement token.
4. Save.
5. Update the deployed Apps Script source with the tested `Code.gs`.
6. Create a new deployment version while keeping the existing web-app URL.

- [ ] **Step 7: Execute one explicitly approved end-to-end order notification**

Use a designated test store/order and confirm:

- The order is stored.
- The expected WhatsApp notification is delivered.
- The Apps Script execution log contains success but no token value.
- Portal B2B remains available on its existing URL.

If it fails, restore the previous Apps Script deployment version. Do not revoke
the old Meta token.

- [ ] **Step 8: Revoke the exposed token**

After the replacement notification succeeds, revoke the old token in Meta and
repeat the designated test. Record only the timestamp and outcome.

- [ ] **Step 9: Commit token removal and evidence**

```bash
git add creditek/portal/Code.gs tests/security/portal-apps-script.test.mjs docs/security/cloudflare-containment-baseline.md
git commit -m "security: move Portal Meta token to Script Properties"
```

---

### Task 9: Final Verification and Handoff

**Files:**
- Modify: `docs/security/cloudflare-containment-baseline.md`

**Interfaces:**
- Consumes: all completed containment work.
- Produces: final verification evidence and a clean handoff to the next independent migration design.

- [ ] **Step 1: Run all local tests and artifact verification**

```bash
npm run build
npm test
```

Expected: every test passes.

- [ ] **Step 2: Run fresh production tests**

```bash
BASE_URL='https://registro.crediteksas.com' node --test tests/security/live-smoke.test.mjs
curl --fail --silent https://creditek-gemini-proxy.comercial-853.workers.dev/health | jq -e '.ok == true and .wif == true and .jwks == true'
```

Expected: all smoke tests and health assertions pass.

- [ ] **Step 3: Verify repository and tracked-secret state**

```bash
gh repo view oscarjp88-arch/consultora --json visibility --jq '.visibility'
git ls-files '*.pem' '*.key' '*.jwk.json'
git grep -n -E 'EAA[A-Za-z0-9]{40,}|BEGIN (RSA )?PRIVATE KEY' -- . \
  ':(exclude)docs/security/*'
```

Expected:

- Visibility is `PRIVATE`.
- No private-key file is tracked.
- No current source contains a literal long Meta token or PEM private key.
- Historical Git commits are still treated as compromised.

- [ ] **Step 4: Verify Cloudflare automation and schedules**

Confirm in the dashboard:

- Latest private-repository `consultora` build is `Success`.
- The custom domain remains `registro.crediteksas.com`.
- All recorded `creditek-bot` and `creditek-clientes` Cron Trigger expressions
  match baseline.
- Recent Cron execution timestamps continue advancing.
- Google Apps Script URLs for Portal and Convenios are unchanged.

- [ ] **Step 5: Commit final evidence**

```bash
git add docs/security/cloudflare-containment-baseline.md
git commit -m "docs: complete Cloudflare security containment evidence"
```

- [ ] **Step 6: Start the next design, not its implementation**

Create a separate brainstorming/design cycle for `creditek-meta-ads`. Do not
mix the Meta Ads migration, D1, R2, new subdomains, or browser-key removal into
this containment branch.
