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
| `sessions` | token_hash, id (public), user_id, device_id, client, created_at, last_seen_at |
| `devices` | id, user_id, platform, apns_token, app_version, apns_environment (`sandbox`\|`production`) |
| `packages` | id (uuid), user_id, carrier, tracking_number, title, merchant, order_id, source (`manual`\|`amazon`\|`flint`\|`share`), status, status_detail, eta_start, eta_end, eta_date_only, delivered_at, last_checked_at, next_check_at, archived_at, deleted_at, updated_at, UNIQUE(user_id, carrier, tracking_number) |
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

**Tracking providers.** Porchlight pays for no tracking service (owner decision, 2026-11-08). Each carrier has a `CarrierAdapter { id, source, track(number) → { status, eta, events[] } }` whose `source` is `api`, `web` or `aggregator`. The endpoints, parsers, status maps and terms for each carrier are in `docs/research/scraping.md`; parts of the mappings are ported from universal-parcel-scraper (Apache-2.0, credited in `THIRD_PARTY_NOTICES.md`).

| Carrier | Primary | Fallback | Who reads it |
|---|---|---|---|
| USPS | device: the app's hidden web view on `tools.usps.com` | aggregator | Mac or iPhone app |
| UPS | `web:ups` server read of the public tracking API | device, when the server is blocked (401/403/428, a challenge or a timeout) | server, then app |
| FedEx | device: the app's hidden web view on `fedex.com` | aggregator | Mac or iPhone app |
| DHL Express | DHL Unified Shipment Tracking API (free key, 250 calls a day; approval pending) | aggregator | server |
| DHL eCommerce | `web:dhl_ecommerce` | aggregator | server |
| Amazon Logistics | `web:amazon` (the public tracker API); the Amazon import's `observed` block (§6) also updates it | none: Amazon numbers never go to the aggregator | server, and the app during an import |
| OnTrac, LaserShip | `web:ontrac` | aggregator | server |
| UniUni | `web:uniuni` | aggregator | server |
| Jitsu | `web:jitsu` | aggregator | server |
| everything else | aggregator | none | server |

`pickAdapters` returns a configured direct API first, then the web adapter, then the aggregator. For USPS, UPS and FedEx the device is the main path; FedEx's sandbox keys are never used for real numbers.

**Device carriers.** USPS, UPS (once `web:ups` is blocked) and FedEx turn away the Worker, so the native apps read them. The server sets `packages.device_needed_at` when a read is due. The apps ask `GET /v1/device-tracking/due` for up to 10 jobs and load each carrier page in a hidden `WKWebView` with its own persistent data store, apart from the Amazon one. They post what they read to `POST /v1/packages/:id/observed` with outcome `ok`, `not_found`, `challenged` or `failed` (docs/API.md "Device tracking"). An observation older than the package's last check changes nothing. A challenge or failure pushes the next read back. The app never solves a CAPTCHA. These packages update only while the Mac app or menu-bar item runs, while the iPhone app is open, or when iOS grants background refresh. A device carrier package with no read in the last 3 hours shows "Open Porchlight on your Mac or iPhone to update USPS packages" on the web, and a matching line in the apps.

**Aggregator.** Ship24's free tier allows 10 new trackers a month. A KV counter under `aggregator:<YYYY-MM>` (UTC) counts registrations, the first call for a number; later reads of a registered tracker don't count. The aggregator is used only when no API, web or device path exists for the carrier (`other`, or a web adapter that answered not found or failed permanently twice), and only while the month's count is under `AGGREGATOR_MONTHLY_LIMIT` (default 10).

**Where the status came from.** `packages.last_source` holds `api`, `web`, `aggregator`, `device` or `amazon` and is sent as the package's `dataSource`. The detail view shows it with the check time under the timeline, for example "From UPS's tracking page, checked on your Mac or iPhone 12 min ago."

**DHL terms.** When a DHL package's data came from the DHL API, the server sends `attribution: "Delivered by Deutsche Post DHL Group"` and every client shows it under the timeline. A cron deletes the events of those packages 30 days after `delivered_at`; the package row stays.

**Polling.** A Cron trigger runs every 5 minutes and queues packages whose `next_check_at` has passed, and a Queue consumer calls the adapters. Per-package intervals (scraping.md "Polling limits"):

| Feed | Out for delivery | In transit | Label created | After a failure |
|---|---|---|---|---|
| Server feeds (`web:*`) | 15 min | 1–2 h | 6 h | exponential backoff, up to 2 h |
| DHL API | 30 min | 2 h | 6 h | Retry-After; 250 a day in all |
| USPS (device) | 30 min | 2 h | 6 h | 60 min |
| UPS, FedEx (device) | 20–30 min | 2 h | 6 h | 60 min |

Delivered packages stop. Each feed gets at most about 20 requests per carrier an hour from one IP or device; devices run one lookup per carrier at a time, at least 5 s apart. A package shows "Last checked 14 min ago" and a manual refresh button, limited to one per 2 minutes. For a device carrier, refresh asks the apps for a read (`device_needed_at = now`, reason `manual`) instead of queuing a server check.

**Risk.** The carriers' terms bar automated reading of their sites (scraping.md "Terms"). The owner accepted that on 2026-11-08 for low volume and the owner's own packages, best effort. Any page change or bot check can stop a carrier; the package then shows its last good read and when it was taken.

## 6. Amazon import (native apps)

You sign into Amazon once, inside the app: Settings → Connected accounts → Amazon opens a `WKWebView` on amazon.com sign-in. 2FA and captcha are handled by you, on Amazon's own page.

- Cookies live only in a dedicated, persistent `WKWebsiteDataStore` on that device. They are never sent to the Porchlight server and are not synced. Each device that should import signs in separately; usually one is enough.
- When an import runs, the app loads Your Orders in a hidden web view, along with each open order's "Track package" page. A small injected script reads order id, items (name, image, quantity), ETA, carrier and tracking number. For Amazon Logistics it reads the TBA number and the status timeline. The app posts results to `/v1/imports/amazon`, deduped by order and shipment id.
- **Schedule:**
  - Mac: every 30 min while the app or its menu-bar helper runs.
  - iPhone: on open, and through `BGAppRefreshTask`, which iOS limits.
  - Never more than once every 15 min.
- **Failure is visible.** When Amazon asks you to sign in again, or the page layout changes and the parser finds nothing, the Amazon row in Settings says so with a time. Packages are never silently dropped.
- **Parser tests.** The parser is tested against saved, redacted Amazon pages in `PorchKit/Tests/PorchKitTests/Amazon/Fixtures/` (made with `scripts/redact-amazon-fixture.py`).
- **Scope:** amazon.com first; other Amazon sites later.
- **Web.** The web app shows Amazon packages that the native apps synced. It cannot sign into Amazon itself; a browser won't let one site read another's pages. Instead it tells you to connect Amazon in the Mac or iPhone app.
- **Risk.** This reads your own account the way a person would, at a low rate. Amazon could change the page or challenge the session at any time, so it is best effort, and it's described that way in the app.

## 7. Flint integration (in the Flint repo)

- **Pairing.** "Connect Flint" in Porchlight Settings (web or Mac), or "Connect Porchlight" in Flint (which opens `/app/connect/flint`), makes a one-time pairing code and opens Flint with `flint://porchlight/pair?code=…&host=porchlight.xanom.co`. Flint looks up the account with `POST /v1/pairing/peek`, asks the user to confirm, then exchanges the code for an `api_token` with the `imports:write` scope, stored in Flint's keychain. The code can still be typed into Flint by hand.
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
- Device reads: the apps open USPS, UPS and FedEx tracking pages on the user's own device and send Porchlight only the parsed status, ETA and events. The carrier sees the tracking number and the device's IP, as it would for a person. Carrier cookies stay in a data store on that device, separate from the Amazon store, and are never synced.
- DHL API data: events are purged 30 days after delivery, and clients show the attribution DHL's terms require.
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
