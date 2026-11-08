# Porchlight

A delivery tracker for one person's packages: native Mac and iPhone apps plus a web app, synced through one account. See [docs/SPEC.md](docs/SPEC.md).

## Layout

| Path | What |
|---|---|
| `packages/carriers` | `@porchlight/carriers`: carrier detection, adapters and normalized types (TypeScript) |
| `services/api` | `@porchlight/api`: Cloudflare Worker with D1, Queues, Cron and KV |
| `docs/API.md` | the HTTP API contract |
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

## Develop

Node 22 and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm test        # vitest; the API tests run in workerd with migrations applied
```

Tests never call carrier APIs. Adapters take an injected `fetch` and replay recorded responses.
