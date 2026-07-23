# CREDITEK Cloudflare Security Containment Design

**Date:** 2026-07-23

## Objective

Contain the current public exposure of internal source files and credentials
without interrupting any CREDITEK application, scheduled task, Worker, Google
Apps Script, domain, or data flow.

This specification covers only the first containment phase. The later
migrations of Meta Ads, Portal B2B, Convenios, and the creative agents will
have separate specifications and implementation plans.

## Current State

- `registro.crediteksas.com` is served by the Cloudflare `consultora` static
  assets deployment.
- The deployment source is the public GitHub repository
  `oscarjp88-arch/consultora`.
- Four AI agents and three commercial tools are available under the CREDITEK
  domain.
- Portal B2B and Convenios still use active Google Apps Script backends.
- Existing Cloudflare Workers and their Cron Triggers run independently of the
  GitHub repository.
- An internal Portal B2B Apps Script source file is included in the static
  deployment and is publicly retrievable.
- A private key used by the Gemini proxy is tracked in the public repository
  and must be treated as compromised.
- Credentials found in public source must be treated as compromised and
  rotated after their replacements are installed and verified.
- Some legacy browser applications still contain shared credentials required
  by their current architecture. Removing those values safely requires the
  dedicated Worker migrations that are explicitly deferred from this phase.

## Non-Negotiable Constraints

- Keep every existing public URL functional throughout the phase.
- Do not modify ERP or Sofía application behavior.
- Do not disable or migrate any Google Apps Script in this phase.
- Do not stop or edit existing Cloudflare Cron Triggers.
- Do not revoke the existing exposed credential before its replacement works.
- Do not expose secret values in logs, documentation, commits, or chat.
- Do not remove a legacy browser credential until its server-side replacement
  exists and has passed an end-to-end test.
- Stop at the first failed validation and restore the last verified state.

## Chosen Repository and Hosting Model

- Cloudflare remains the production runtime and public delivery platform.
- GitHub remains the source-control backup and deployment source.
- The repository becomes private under GitHub Free.
- Cloudflare is explicitly authorized to read the private repository.
- End users see only CREDITEK-controlled domains.
- A later administrative project may transfer ownership to a CREDITEK GitHub
  organization without changing production URLs.

## Containment Sequence

### 1. Establish a Baseline

Record status and visible behavior for:

- Agent 1, Design and Social Media.
- Agent 2, Responses and Sofía supervision.
- Agent 3, Meta Ads Intelligence.
- Agent 4, Content Calendar.
- Portal B2B.
- Google Business Profile reference tool.
- Convenios.
- Existing Worker health endpoints where available.
- Existing scheduled Worker configuration.

No write, submission, campaign creation, message send, or document upload is
performed during baseline testing.

### 2. Restrict the Static Asset Set

Update the static-assets inclusion rules so backend source files, scripts,
local utilities, environment files, credentials, backups, and development-only
artifacts cannot be published.

The published artifact must still contain every HTML, JavaScript, CSS, image,
font, catalog, and document required by the seven existing applications.

The internal Apps Script source remains available locally for the current
backend but is excluded from the Cloudflare static artifact.

### 3. Validate Before Production

Build the exact static artifact locally and enforce automated assertions:

- Required public files are present.
- Internal backend source files are absent.
- Private keys, backend source files, and server-only credential patterns are
  absent from the artifact.
- Known legacy browser credentials are reported as accepted unresolved
  findings rather than silently treated as secure.
- Existing relative links resolve inside the artifact.
- The Cloudflare deployment configuration passes validation.

### 4. Deploy and Verify Containment

Deploy the restricted artifact through the existing Cloudflare pipeline.

Post-deployment verification must confirm:

- All seven application entry points return successful responses.
- Required assets load.
- The internal Apps Script source URL returns `404` or an equivalent
  non-disclosure response.
- Existing Workers and scheduled tasks remain configured.
- Portal B2B and Convenios continue using their current backends.

If any application validation fails, roll back to the prior Cloudflare
version. The sensitive source URL remains a release blocker: a rollback is
temporary and must be followed by a corrected containment deployment.

### 5. Make GitHub Private Without Breaking Builds

Change repository visibility from public to private, then grant the existing
Cloudflare Git integration access to the private repository.

The already deployed Cloudflare version remains active during this change.
Run one controlled deployment that changes no application behavior and verify
that Cloudflare can still fetch and build the private repository.

If the private build fails, keep production on the last verified Cloudflare
version and repair only the Git integration permissions.

### 6. Rotate the Exposed Credentials Safely

Create replacement credentials with the minimum required permissions.

For Portal B2B, install the replacement first in the active backend using a
server-side secret store or script property rather than source code. Execute a
non-destructive backend health check and one explicitly approved end-to-end
test.

For the Gemini proxy, introduce a dual-public-key transition, verify that the
new key can obtain a Google federated token and generate a test image, then
remove the compromised key from the Worker JWKS and repository.

Only after the replacement is proven operational:

- Revoke the corresponding exposed credential.
- Confirm the old credential or key no longer works.
- Confirm the new credential or key continues to work.
- Record the rotation date without recording either credential value.

Historical Git commits must be treated as permanently exposed even after the
repository becomes private.

Legacy shared credentials embedded in the browser agents are documented but
not removed during this phase because doing so before their replacement
Workers exist would break production behavior.

## Validation Matrix

| Component | Read-only baseline | Post-deploy | Post-private-repo |
|---|---:|---:|---:|
| Agent 1 | Required | Required | Required |
| Agent 2 | Required | Required | Required |
| Agent 3 | Required | Required | Required |
| Agent 4 | Required | Required | Required |
| Portal B2B | Required | Required | Required |
| Google Business | Required | Required | Required |
| Convenios | Required | Required | Required |
| Internal source inaccessible | Record exposure | Must pass | Must pass |
| Worker Cron configuration | Record | Unchanged | Unchanged |
| Cloudflare Git build | Record | Required | Must pass |

## Rollback Strategy

- Preserve the identifier of the last verified Cloudflare production version.
- Never delete the previous version during this phase.
- Roll back the static deployment if a public application fails.
- Do not roll back repository visibility merely because a private build fails;
  repair Cloudflare repository access while the existing deployment continues
  serving traffic.
- Do not revoke the old credential until the new credential passes its
  approved test.
- Do not change DNS during this phase.

## Completion Criteria

The containment phase is complete only when:

1. All seven applications remain available on their existing CREDITEK URLs.
2. Internal backend source files are not publicly retrievable.
3. The repository is private.
4. Cloudflare can deploy from the private repository.
5. Existing Workers, Cron Triggers, Google Apps Scripts, ERP, and Sofía remain
   operational and behaviorally unchanged.
6. The exposed Portal backend credential and Gemini private key have been
   replaced and revoked without an interruption.
7. Fresh verification evidence is recorded for every completion claim.

## Deferred Work

The following work is intentionally excluded and requires separate designs:

- Dedicated `creditek-meta-ads` Worker.
- Portal B2B migration from Google Apps Script to Workers and D1.
- Convenios migration to Workers, D1, and R2.
- Cloudflare Access and role-based authorization.
- Migration of browser-side AI provider keys into Workers Secrets.
- Removal and rotation of legacy browser-shared Worker credentials.
- New CREDITEK subdomains or DNS changes.
- Transfer to a CREDITEK-owned GitHub organization.
