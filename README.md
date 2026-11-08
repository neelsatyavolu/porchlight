# Porchlight

A delivery tracker for one person's packages: native Mac and iPhone apps plus a web app, synced through one account. See [docs/SPEC.md](docs/SPEC.md).

## Layout

| Path | What |
|---|---|
| `apps/web` | `@porchlight/web`: the signed-in web app (React 18, Vite, react-router), served under `/app` |
| `site` | `@porchlight/site`: marketing pages (plain HTML), served at `/` |
| `packages/carriers` | `@porchlight/carriers`: carrier detection, adapters and normalized types (TypeScript) |
| `services/api` | `@porchlight/api`: Cloudflare Worker with D1, Queues, Cron and KV |
| `docs/API.md` | the HTTP API contract |
| `DESIGN.md` | the design system for web and Apple apps |
| `docs/research/` | Phase 1 research: aggregator, number formats, carrier APIs |

## Contracts

Parallel work depends on these files. Change them only on purpose, and update every consumer in the same change.

- `packages/carriers/src/types.ts`: carrier ids, statuses, `CarrierAdapter`, `CarrierError`
- `packages/carriers/fixtures/numbers.schema.json`: the shared number fixtures, also used by Swift
- `services/api/migrations/0001_init.sql`: the D1 schema
- `services/api/src/env.ts`: bindings and secrets
- `services/api/src/types/api.ts` and `docs/API.md`: the wire format
- `services/api/src/lib/http.ts`: the response envelope
- `services/api/src/lib/auth.ts`: the auth helpers
- `services/api/src/lib/rate.ts`: rate limiting
- `services/api/src/poll/types.ts`: the queue message
- `apps/web/src/api/types.ts`: the web's copy of the wire types; `contract.check.ts` fails `tsc` if it drifts from the server's
- `apps/web/src/styles/tokens.css`: design tokens, also copied into the site

## Develop

Node 22 and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm test        # vitest; the API tests run in workerd, the web tests in jsdom
pnpm build       # site + web into services/api/public, then a dry-run Worker bundle
pnpm dev         # wrangler dev on :8787 and Vite on :5173
```

`pnpm dev` builds the site, applies the D1 migrations to the local database, then starts `wrangler dev` (API, site and the last built app on http://localhost:8787) and Vite (the web app with hot reload on http://localhost:5173, `/v1` proxied to :8787). It sets `APP_ORIGIN` to `http://localhost:5173` so the API's Origin check accepts the Vite page. Safari may refuse the `Secure` session cookie on plain-http localhost; use Chrome or Firefox for local sign-in.

Email sign-in sends mail only with `RESEND_API_KEY` in `services/api/.dev.vars`. Without it, `pnpm dev` passes `EMAIL_DEV_LOG=1`, so the link and 6-digit code are printed in the wrangler output instead (localhost origins only). A plain `wrangler dev` without the var answers 503.

## Serving

One Worker serves all of porchlight.xanom.co. `services/api/public/` is build output (gitignored):

```
services/api/public/
  index.html, privacy.html, terms.html, 404.html   site/src/*.html
  styles/tokens.css                                apps/web/src/styles/tokens.css
  styles/site.css, styles/fonts.css, fonts/*.woff2 site/build.mjs
  app/index.html, app/assets/*                     apps/web (Vite, base /app/)
  _headers                                         site/build.mjs, from services/api/src/lib/security-headers.json
```

Routing (`services/api/wrangler.jsonc` and `src/lib/assets.ts`):

| Request | Served by |
|---|---|
| `/v1/*` | the API (Worker first) |
| `/app/*`, `/signin`, `/signin/*`, `/auth/verify` | Worker first: the matching file, else `app/index.html` |
| `/app/assets/*` | static files only |
| everything else | static files (`/privacy` finds `privacy.html`); misses get `404.html` with status 404 |

`site/build.mjs` only replaces its own files (root `*.html`, `styles/`, `fonts/`), and Vite only empties `public/app`, so the two builds can run in either order. The list of app routes lives in two places, `run_worker_first` and `APP_ROUTE` in `assets.ts`; change them together.

Security headers (CSP, nosniff, frame and referrer policy) live in `services/api/src/lib/security-headers.json`. `serveAssets` sets them on what the Worker serves, and `public/_headers` sets them on files Cloudflare serves without it. The CSP allows Apple's sign-in script and popup; add any new third-party origin there.

Tests never call carrier APIs. Adapters take an injected `fetch` and replay recorded responses.
