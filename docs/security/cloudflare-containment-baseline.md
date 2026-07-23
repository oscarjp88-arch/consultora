# Cloudflare containment baseline

- Captured at: 2026-07-23T18:30:38Z
- Git commit: `1689416a1bb06e2af2fdcd6f96c28e2c7a221029`
- GitHub visibility: `PUBLIC`
- GitHub default branch: `main`
- Consultora active version: `64fa70d5-3296-4395-a4a2-0d1d83c7822e`
- Gemini proxy active version: `ded02e27-7977-41b7-8b46-91da0fe7159a`
- Clientes active version: `bcacfca3-3c20-475f-a778-62bef93cb8ca`
- PDF combiner active version: `9d2d60da-9b5e-4e23-be0e-fc7c7183b0d0`
- Sofía active version: `72a70251-f9b9-444b-9cce-da8769d46305`
- Public application checks: 8/8 available
- Internal Apps Script source: exposed; HTTP 200
- Gemini private key path: exposed; HTTP 200
- Portal Google Apps Script: active and unchanged
- Convenios Google Apps Script: active and unchanged

## Existing scheduled tasks

These schedules are evidence only. This phase must not change them.

### `creditek-clientes`

- `*/5 16-23 * * *`
- `*/5 0 * * *`

### `creditek-bot` (Sofía)

- `*/30 * * * *`
- `0 22 * * *`
- `0 18 * * *`
- `0 14 * * 1-5`
- `0 13 * * *`

## Baseline test result

`node --test tests/security/live-smoke.test.mjs`

- Passed: 8
- Failed: 2
- Expected failures:
  - `/creditek/portal/Code.gs` returned HTTP 200 instead of 404.
  - `/creditek/workers/gemini-proxy/wif-private.pem` returned HTTP 200 instead of 404.
