# Porchlight: specification (draft 1, 2026-11-08)

"Porchlight" is a working name. Changing it before Phase 1 ships costs nothing.

A delivery tracker for one person's packages. It runs as a native app on Mac and iPhone and as a website, all synced through one account. Packages arrive on their own: from your Amazon account, from shipping mail Flint sees, or pasted by hand. Every major carrier is tracked.

## 1. Goals

1. **Packages arrive on their own.** Most packages should never be typed in. The sources are Amazon (signed in inside the app), Flint (shipping mail), and paste or share-sheet as a fallback.
2. **Every main carrier.** USPS, UPS, FedEx, DHL, Amazon Logistics (TBA), Jitsu, OnTrac/LaserShip, UniUni, and the long tail through an aggregator.
3. **One calm list.** Packages are grouped by when they arrive (Today, Tomorrow, This week, Later, Delivered). The detail view shows a timeline, the ETA, the source, and the items when known.
4. **Honest status.** The app shows what the carrier last said and when it said it. It never makes up an ETA.
5. **Private by default.** Amazon credentials and cookies stay on the device. Flint sends only what it extracted (carrier, number, merchant, subject line), never mail bodies.

Out of scope for v1: shipping labels, buying postage, Android, team accounts, and package photos from carriers.

## 2. Architecture

```
apps/apple        SwiftUI multiplatform (iOS 18+, macOS 15+), XcodeGen, one target per platform
  Packages/PorchKit   shared Swift: API client, models, sync store (SwiftData), carrier detection, Amazon importer
apps/web          the signed-in web app (React + Vite), served by the Worker's static assets
site/             marketing pages (porchlight.xanom.co), same Worker
services/api      Cloudflare Worker + D1 + Queues + Cron: accounts, sync, carrier polling, push
packages/carriers TypeScript: number → carrier detection, carrier adapters, normalized events (used by api + web)
```

Flint integration ships in the Flint repo (§7). The carrier-detection rules exist twice, as TS in `packages/carriers` and as Swift in `PorchKit`. Both run against one shared fixture file, `packages/carriers/fixtures/numbers.json`, so they can't drift apart.

## 3. Accounts and sync

- **Sign-in.** Sign in with Apple (all three clients), plus an email magic link sent through Resend for the web and for people without an Apple ID. Sessions are opaque random tokens, stored as hashes in D1. Native apps keep them in the Keychain; the web keeps them in an HttpOnly cookie.
- **Sync.** REST plus a cursor. `GET /v1/sync?since=<cursor>` returns changed packages and events, with tombstones for deletes. Every write is `PUT /v1/packages/:id` with a client-generated UUID, so it's idempotent. Last write wins per field, using a server timestamp. Native apps keep a local SwiftData store and work offline. The web app keeps no local store.
- **Push.** APNs on iOS and macOS. A visible push fires for "Out for delivery", "Delivered" and "Exception". A silent push fires for any other change so the apps can refresh. The web app polls every 60 s while visible.
- **Devices.** Each device registers its APNs token. Signing out removes it.

## 4. Data model (D1)

| Table | Key columns |
|---|---|
| `users` | id, apple_sub, email, created_at |
| `sessions` | token_hash, user_id, device_id, created_at, last_seen_at |
| `devices` | id, user_id, platform, apns_token, app_version |
| `packages` | id (uuid), user_id, carrier, tracking_number, title, merchant, order_id, source (`manual`\|`amazon`\|`flint`\|`share`), status, status_detail, eta_start, eta_end, delivered_at, last_checked_at, next_check_at, archived_at, deleted_at, updated_at, UNIQUE(user_id, carrier, tracking_number) |
| `package_items` | package_id, name, image_url, quantity (from Amazon) |
| `events` | id, package_id, occurred_at, status, description, location, raw_hash (dedupe) |
| `imports` | user_id, source, dedupe_key (Flint message id, Amazon order+shipment id), package_id, created_at |
| `api_tokens` | token_hash, user_id, label (`Flint on <Mac>`), scopes, created_at, last_used_at |

Normalized status values: `label_created`, `in_transit`, `out_for_delivery`, `available_for_pickup`, `delivered`, `exception`, `returned`, `unknown`.

## 5. Carriers

**Detection** (`detectCarrier(number) → Candidate[]`). This is a pure function using format rules and checksums. Each result comes with a confidence level, and ambiguous numbers return several candidates. Patterns to start from, all to be confirmed against real numbers in Phase 1:

- UPS: `1Z` + 16 chars, with a checksum.
- FedEx: 12, 15, 20 or 22 digits, with a mod-11 or mod-10 check.
- USPS: 20–22 digits starting `9x`, or S10 international (`AA123456789US`).
- DHL Express: 10 digits. DHL eCommerce: `GM…`, `420…`.
- Amazon Logistics: `TBA` + 12 digits.
- OnTrac: `C`/`D` + 14 digits, or 1LS… (LaserShip).
- Jitsu: format not yet known. Phase 1 research finds it from real mail or the aggregator's carrier list.

**Tracking providers.** Each carrier has a `CarrierAdapter { track(number) → { status, eta, events[] } }`:

| Carrier | Primary | Fallback |
|---|---|---|
| USPS | USPS Tracking API v3 (OAuth, free) | aggregator |
| UPS | UPS Track API (OAuth, free) | aggregator |
| FedEx | FedEx Track API (free) | aggregator |
| DHL | DHL Unified Shipment Tracking API (key, free tier) | aggregator |
| Amazon Logistics | status read by the device from the Amazon track page (§6) | aggregator |
| Jitsu, OnTrac, UniUni, everything else | aggregator | — |

The aggregator is chosen in Phase 1 from Ship24, 17TRACK and TrackingMore. The choice depends on Jitsu and TBA coverage, webhook support, free tier and per-shipment price. The candidates go to you before any account is created. Direct carrier keys need you to register developer apps; until then each carrier falls back to the aggregator.

**Polling.** A Cron trigger runs every 5 minutes and queues packages whose `next_check_at` has passed, and a Queue consumer calls the adapters. Check intervals depend on status:
- out for delivery: every 15 min
- in transit: every 1–2 h
- label created: every 6 h
- delivered: stop

Webhooks from the aggregator update packages directly when they're available. Per-carrier rate limits are enforced with a token bucket in KV. A package shows "Last checked 14 min ago" and a manual refresh button, rate-limited to one per 2 min.

## 6. Amazon import (native apps)

You sign into Amazon once, inside the app: Settings → Connected accounts → Amazon opens a `WKWebView` on amazon.com sign-in. 2FA and captcha are handled by you, on Amazon's own page.

- Cookies live only in a dedicated, persistent `WKWebsiteDataStore` on that device. They are never sent to the Porchlight server and are not synced. Each device that should import signs in separately; usually one is enough.
- When an import runs, the app loads Your Orders in a hidden web view, along with each open order's "Track package" page. A small injected script reads order id, items (name, image, quantity), ETA, carrier and tracking number. For Amazon Logistics it reads the TBA number and the status timeline. The app posts results to `/v1/imports/amazon`, deduped by order and shipment id.
- **Schedule:**
  - Mac: every 30 min while the app or its menu-bar helper runs.
  - iPhone: on open, and through `BGAppRefreshTask`, which iOS limits.
  - Never more than once every 15 min.
- **Failure is visible.** When Amazon asks you to sign in again, or the page layout changes and the parser finds nothing, the Amazon row in Settings says so with a time. Packages are never silently dropped.
- **Parser tests.** The parser is tested against saved, redacted Amazon pages in `PorchKit/Tests/Fixtures/amazon/`.
- **Scope:** amazon.com first; other Amazon sites later.
- **Web.** The web app shows Amazon packages that the native apps synced. It cannot sign into Amazon itself; a browser won't let one site read another's pages. Instead it tells you to connect Amazon in the Mac or iPhone app.
- **Risk.** This reads your own account the way a person would, at a low rate. Amazon could change the page or challenge the session at any time, so it is best effort, and it's described that way in the app.

## 7. Flint integration (in the Flint repo)

- **Pairing.** Porchlight Settings → Connections → Flint shows a one-time pairing code. Flint Settings → Connections → Porchlight takes that code and exchanges it for an `api_token` with the `imports:write` scope, stored in Flint's keychain.
- **Detection.** `packages/core/src/tracking/detect.ts` grows carriers: UPS, DHL, Amazon (TBA plus Amazon shipped and out-for-delivery mail), Jitsu, OnTrac. Each new carrier comes with a redacted fixture, the same way the existing ones were added.
- **Import.** For each new message where detection finds a package, Flint posts `{ carrier, tracking_number, merchant (sender name), subject, message_date, dedupe_key: message-id }` to `/v1/imports/flint`. It does this for new mail only, plus a one-time backfill of the last 30 days when pairing. Mail bodies never leave the Mac.
- **In Flint.** A thread with a detected package shows a small "Tracking in Porchlight" chip that links to the package.

## 8. Clients

**Apple app (SwiftUI, one codebase).**
- iPhone: a list grouped by arrival day, then a detail view with the timeline. The add sheet takes paste or a scan of a label barcode (VisionKit). A share extension accepts text and URLs.
- Mac: a two-pane window, plus a menu-bar item that shows today's deliveries.
- Both: notifications, a widget (Today's deliveries), and on iOS a Live Activity for out-for-delivery packages (Phase 4).

**Web app.** The same list and detail views, add by paste, settings (sessions, Flint pairing, connected accounts, delete account).

**Design.** The "Blackletter" system from `~/DESIGN.md`: black canvas, Geist Serif for display, Geist for UI, Geist Mono for tracking numbers, one blue accent `#4C8DFF`, hairlines, 8–12px radii. On Apple platforms it maps onto native controls (SF fonts are not substituted in system chrome). Status color is the only other color: green for delivered, amber for exception. A project `DESIGN.md` is written in Phase 2.

## 9. Security and privacy

- Session and API tokens are stored as SHA-256 hashes, and every query is scoped by user id.
- Carrier and aggregator keys are Worker secrets.
- CORS allows only the app's own origin.
- Auth, import and refresh endpoints are rate-limited.
- Deleting an account removes all rows immediately.
- No analytics beyond the existing n3el analytics contract (page views only), and none in native apps without asking you first.

## 10. Phases

Each phase ends with tests passing, a review (`review_changes`), and a short report. Deploying, creating accounts, or registering with carriers or Amazon waits for your OK.

1. **Backend and carriers.**
   - Research and decide the aggregator, Jitsu formats and the carrier APIs.
   - Build `packages/carriers` (detection, adapters, fixtures) and `services/api` (auth, sync, imports, polling, push stubs).
   - Tests: vitest with recorded carrier responses, so tests make no live calls.
2. **Web app and site.**
   - `DESIGN.md`, the web app and marketing pages.
   - Verified with tsc, vitest, build and HTTP checks.
3. **Apple app.**
   - PorchKit, iOS and macOS targets, sync, notifications, add by paste or scan, share extension.
   - XCTest, simulator builds (one simulator at a time).
4. **Integrations.**
   - The Amazon importer (WKWebView and parser fixtures).
   - Flint pairing and import (Flint repo, coordinated with any Flint sessions).
   - Widget and Live Activity.

## 11. Open decisions (need you)

1. The name and domain: `porchlight.xanom.co`?
2. The aggregator account: after the Phase 1 comparison.
3. Registering developer apps for USPS, UPS, FedEx and DHL: when you're ready; until then everything goes through the aggregator.
4. The Apple signing team, needed for the Phase 3 device builds and for APNs.
