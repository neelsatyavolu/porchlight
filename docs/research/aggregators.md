# Tracking aggregators: Ship24 vs 17TRACK vs TrackingMore

Phase 1 research for SPEC §5. Checked 2026-11-08 against official docs and pricing pages (URLs at the end). Nothing was signed up for and no carrier or aggregator API was called; carrier lists come from public pages and 17TRACK's public carrier JSON. AfterShip is included only as a reference point.

**Recommendation: Ship24**, Tracking API, per-shipment plan, with webhooks. Reasons are in §6. The only real argument against it is price at our tiny volume, which 17TRACK wins (§6.2).

## 1. Summary table

| | Ship24 | 17TRACK (API v2.4) | TrackingMore (API v5) | AfterShip (ref) |
|---|---|---|---|---|
| Carriers claimed | 2,500+ | ~3,500 (3,580 rows in carrier JSON) | ~1,715 | ~1,300+ |
| Auth | `Authorization: Bearer apik_…` | `17token: <key>` header | `Tracking-Api-Key: <key>` header | `as-api-key` header |
| Base URL | `https://api.ship24.com/public/v1` | `https://api.17track.net/track/v2.4` | `https://api.trackingmore.com/v5` | `https://api.aftership.com/tracking/2026-07` |
| Must register first? | Yes: create a tracker (or `POST /trackers/track`, which creates and returns results in one call) | Yes: `/register`, then `/gettrackinfo` or webhook | Yes: `/packages/import` (v5 removed v4's synchronous create) | Yes: `POST /trackings` |
| Billing unit | 1 tracker = 1 shipment, charged at creation; idempotent re-create is free; refreshes free | 1 quota per successful number+carrier registration; follow-up tracking free | 1 credit per number+courier pair; re-fetching free | per shipment |
| Free tier | 10 shipments/mo (+100 bonus in first month), full API + webhooks, hard stop at quota | New accounts after 2026-01-07: one-time 200 (docs). Help center still says 100/mo (stale) | Free plan has **no API**; API starts at Basic (14-day trial) | none with API |
| Cheapest paid API | $39/mo for 1,000 ($0.039 each, overage $0.045), monthly | Prepaid quota valid 12 months, bought manually; price list is behind login. Third-party report: from $119 for 5,000/yr (~$0.024) | Basic, reported $11/mo for 150 credits, overage $0.04 (price not rendered on the official page) | Premium only; overage $0.12 |
| Webhooks | Yes; one URL set in dashboard; `Authorization: Bearer <webhook secret>`; HEAD probe; events may arrive out of order | Yes; one URL; `sign` header = SHA-256 of body + key; 3 retries (10 min, 30 min, 1 h) | Yes; up to 2/5/8 endpoints by plan; HMAC-SHA256 `Signature` over `Timestamp.body`; 13 retries over ~68 h | Yes |
| Rate limit | 10 req/s per endpoint (bulk 3, couriers 1), all plans | 3 req/s | 6 req/s Basic, 10 Pro | per endpoint, 3–20 req/s |
| Batch | `POST /trackers/bulk` up to 100 | 40 numbers per call | 40 per import | — |
| Carrier refresh cadence | "AI-optimized" on Pro, "basic auto-update" on Free; no numbers published | 6–12 h by status, 24 h for delivered/exception; stops after 30 days with no update | Not in v5 docs (Ship24 cites TM help: 4–8 h) | — |
| On-demand refresh | `POST /trackers/track` again with the same payload returns fresh results, no extra quota | `getRealTimeTrackInfo` costs 1 credit per call and **does not support USPS** | none in v5 (realtime create removed) | — |

## 2. Carrier coverage (the carriers SPEC §1 names)

| Carrier | Ship24 | 17TRACK (code) | TrackingMore (code) |
|---|---|---|---|
| Jitsu / AxleHire | Yes, courier page "AxleHire (Jitsu)" → gojitsu.com. Code needs sign-up to read | Yes, `100272` "Jitsu (AxleHire)" | Yes, `axlehire` |
| Amazon Logistics (TBA) | **Generally no.** Ship24's own Amazon page says TBA numbers "can only be followed inside your Amazon account". (An older Ship24 blog page claims TBA support; the newer page contradicts it.) | **Not always.** 17TRACK's Amazon page: TBA "Not always; … use Amazon Your Orders". Has `101392` Amazon Shipping (US) and `100308` Amazon Shipping + MCF | Lists `amazon` and `amazon-us` (Amazon Shipping US); no statement on TBA |
| OnTrac | Yes (listed) | `100049` | `ontrac` |
| LaserShip | Yes (merged into OnTrac) | `100052` | `lasership` |
| UniUni | Yes, courier page | `100134` | `uni` |
| USPS | Yes, but **paid plans only** (site-wide banner) | `21051`; USPS excluded from real-time query; consumer site warns USPS requests are "limited due to policy changes" | `usps` |
| UPS | Yes | `100002` | `ups` |
| FedEx | Yes | `100003` | `fedex` |
| DHL | Yes | `100001` Express, `7047` eCommerce US | `dhl`, `dhlglobalmail` (eCommerce) |

Takeaways:
- **Jitsu**: all three cover it. That was the main open question, and it doesn't separate them.
- **TBA**: no aggregator reliably tracks Amazon Logistics numbers. SPEC §6, where the device reads the Amazon track page, stays the primary source. Porchlight should **not** register TBA numbers with any aggregator by default: each attempt spends a credit and will usually come back as not found. Keep the aggregator as a TBA fallback only if a test number shows it works.
- **USPS** is getting harder for aggregators (Ship24 has made it paid-only, and 17TRACK throttles it). That supports SPEC's plan to make the direct USPS API primary.
- **Jitsu number format** (for `detectCarrier`): not published by Jitsu. A third-party tracker (lastscanned.com) lists "SCD + 16 letters and digits" (e.g. `SCD0000F00410922107`) and "12 or 16 mixed letters and digits". This is unverified and still needs confirming from real mail, as SPEC already plans.

## 3. Request and response shapes

### Ship24 (per-shipment)
- Create: `POST /trackers` with `{ trackingNumber, courierCode?: string[] (≤3), clientTrackerId?, destinationPostCode?, destinationCountryCode?, shippingDate?, settings?: { restrictTrackingToCourierCode } }` → `201 { data: { tracker: { trackerId, trackingNumber, clientTrackerId, isSubscribed, isTracked, createdAt } } }`.
- Create + get now: `POST /trackers/track`, same body → `{ data: { trackings: [ tracking ] } }`. The first call can take up to 60 s.
- Get: `GET /trackers/:trackerId/results`, or `?searchBy=clientTrackerId` → `{ data: { trackings: [ { tracker, shipment, events[], statistics } ] } }`.
- Webhook: `POST` to our URL with `{ trackings: [ { metadata, tracker, shipment, events[] } ] }`. `events` holds only events new since the last push, so dedupe on `eventId`.
- Errors: `{ errors: [{ code, message }], data: null }`.

### 17TRACK
- Register: `POST /register` with `[ { number, carrier?: int, final_carrier?, … } ]` (≤40) → `{ code, data: { accepted: [{ number, carrier }], rejected: [{ number, error: { code, message } }] } }`.
- Get: `POST /gettrackinfo` with `[ { number, carrier } ]` → `accepted[].track_info { latest_status { status, sub_status }, latest_event, time_metrics, milestone, tracking { providers[ { events[] } ] } }`.
- Webhook: `{ event: "TRACKING_UPDATED" | "TRACKING_STOPPED", data: { number, carrier, track_info } }`.
- Errors are numeric codes in the body (e.g. `-18019908` "quotas have ran out", `-18019901` already registered).

### TrackingMore v5
- Import: `POST /packages/import` with `[ { tracking_number, courier_code?, auto_correct?, destination_postal_code?, … } ]` (≤40) → `{ meta: { code, message }, data: { success: [ { id, tracking_number, courier_code, … } ], error: [] } }`.
- Get: `POST /packages/search` with `{ tracking_numbers: "a,b", courier_code? }` → `{ meta, data: [ package { status, sub_status, latest_milestone, events[ { event_status, event_substatus, milestone, event_date, detail, location, raw_status } ] } ], next_id }`.

## 4. Status taxonomies, mapped to Porchlight's

Porchlight statuses (SPEC §4): `label_created`, `in_transit`, `out_for_delivery`, `available_for_pickup`, `delivered`, `exception`, `returned`, `unknown`.

| Porchlight | Ship24 `statusMilestone` (+ `statusCode`) | 17TRACK main status | TrackingMore v5 `status` |
|---|---|---|---|
| `unknown` | `pending` | `NotFound`, `Expired` | `pending`, `querying`, `info_mistake`, `expired` |
| `label_created` | `info_received` | `InfoReceived` | `processing` (verify) |
| `in_transit` | `in_transit` | `InTransit` | `in_transit` |
| `out_for_delivery` | `out_for_delivery` | `OutForDelivery` | `out_for_delivery` |
| `available_for_pickup` | `available_for_pickup` | `AvailableForPickup` | `available_for_pickup` |
| `delivered` | `delivered` | `Delivered` | `delivered` |
| `exception` | `exception`, `failed_attempt` (see open question) | `Exception`, `DeliveryFailure` | `exception`, `delivery_attempted` |
| `returned` | `exception` with `statusCode` `exception_return` | `Exception` + sub `Exception_Returning` / `Exception_Returned` | `return` |

Ship24 also has per-event `statusCategory`/`statusCode` (data, transit, destination, customs, delivery, exception; about 20 codes). 17TRACK has 9 main statuses and 30 sub-statuses. TrackingMore v5 has 9 tracking statuses plus operational sub-statuses (`no_info_yet`, `awaiting_scan`, `required_fields_missing`, …). Ship24's eight milestones map almost 1:1 onto ours.

## 5. Registration and billing implications

All three charge when a number is **registered**, not when it is read. That shapes the adapter:

1. **Only register what needs the aggregator.** USPS, UPS, FedEx and DHL go direct once keys exist (SPEC §5). TBA goes to the Amazon importer. In practice the aggregator gets Jitsu, OnTrac/LaserShip, UniUni and the long tail, plus direct-carrier failures.
2. **Register once and store the provider id.** Store Ship24 `trackerId` on the package and send `clientTrackerId = package.id`. With Ship24, any change to the create payload (another `courierCode`, `destinationPostCode`, `shippingDate`, …) makes a *new* tracker and a new charge, so the payload has to be built deterministically.
3. **Pass the detected courier code.** 17TRACK and TrackingMore charge per number+carrier pair, so a wrong guess followed by a correction costs twice (17TRACK allows 5 free carrier changes). Ship24 accepts up to 3 codes in one tracker.
4. **Don't register before a user owns the package**, e.g. while previewing a pasted number. Deleting and re-adding costs again on all three.
5. **Polling is free once registered** on all three, so the SPEC §5 cadence (15 min while out for delivery) costs nothing extra. Whether it returns *fresher* data depends on the aggregator's own refresh: 17TRACK documents 6–12 h, which defeats the 15-min out-for-delivery cadence. With Ship24, re-calling `POST /trackers/track` triggers a synchronous carrier fetch at no extra quota, which suits the manual refresh button.
6. **Free tiers block at the cap** (Ship24 Free) or have no API at all (TrackingMore Free). Phase 1 tests must use recorded fixtures (SPEC already says so). Ship24 ships `SHIP24_SAMPLE_<MILESTONE>_000` numbers for manual end-to-end checks once an account exists.

## 6. Recommendation: Ship24

### 6.1 Why
1. **Covers Jitsu, OnTrac/LaserShip and UniUni**, the carriers that have no direct path in SPEC §5.
2. **Webhooks and the full API on the free tier**, so the integration can be built and checked end to end before spending anything. TrackingMore's free tier has no API, and 17TRACK's free allowance is a one-time 200.
3. **Clean per-shipment billing.** One tracker follows a parcel across courier handoffs, creation is idempotent, and refreshes are free. Monthly billing that can be cancelled any time; no 12-month prepay.
4. **On-demand refresh** via `POST /trackers/track` at no extra cost. This matches "Last checked 14 min ago" plus the refresh button. 17TRACK's equivalent costs a credit and excludes USPS.
5. **Status model fits ours.** `statusMilestone` covers SPEC's normalized statuses almost 1:1 and appears on every event.
6. **Best docs for building with fixtures:** a public OpenAPI 3.1 spec (`docs.ship24.com/assets/openapi/ship24-tracking-api.yaml`) with full example payloads, documented error codes, rate-limit headers, and sample tracking numbers. Recorded-response tests can be written from the spec without an account.
7. **Highest rate limit** (10 req/s on every plan), which is plenty.

### 6.2 Costs and caveats
- **Price at our volume.** One person's packages that actually need the aggregator probably run 10–40 a month. Ship24 Free (10/mo, hard stop) may not be enough, and the next step up is $39/mo for 1,000, mostly unused. A 17TRACK prepaid quota (reportedly ~$119 for 5,000/yr, but behind login) or TrackingMore Basic (~$11/mo) is cheaper. If cost matters more than the points above, **17TRACK is the runner-up**: widest coverage including Jitsu, and per-registration billing. Its downsides are the 6–12 h refresh, 3 req/s, only 3 webhook retries, and paid real-time refresh that excludes USPS.
- **USPS on Ship24 is paid-only.** That's fine while USPS goes direct, but the aggregator fallback for USPS only works on a paid plan.
- **Webhook auth is a static bearer secret**, not an HMAC over the body. Compare it in constant time, and treat payloads as untrusted (re-fetch by `trackerId` before acting on a status change if we want to be strict).
- **Courier codes** (e.g. Jitsu's) come from `GET /couriers` or a dashboard CSV, which both need an account. Until then, rely on auto-detect and leave `courierCode` empty for Jitsu.
- **Webhooks can arrive out of order.** Keep the newest `occurrenceDatetime`, and dedupe on `eventId` (fits `events.raw_hash` in SPEC §4).
- Most of the comparison numbers for competitors that appear on Ship24's own blog are marked "reported" above and were not used as primary evidence.

## 7. Sample response (Ship24, from the official OpenAPI example)

`GET /public/v1/trackers/{trackerId}/results` → `200`. Shape and values come from the `tracking` schema example in Ship24's OpenAPI spec, wrapped in the documented `data.trackings[]` envelope. The middle events are trimmed (the original has 9). This can seed `packages/carriers/fixtures/ship24/results-delivered.json`.

```json
{
  "data": {
    "trackings": [
      {
        "tracker": {
          "trackerId": "26148317-7502-d3ac-44a9-546d240ac0dd",
          "trackingNumber": "9400115901047177598206",
          "shipmentReference": "c6e4fef4-a816-b68f-4024-3b7e4c5a9f81",
          "clientTrackerId": "3fa99515-3ca0-4901-85bb-056ee016799b",
          "isSubscribed": true,
          "isTracked": true,
          "createdAt": "2021-03-10T05:13:00.000Z"
        },
        "shipment": {
          "shipmentId": "f4f888d7-d140-423f-9a48-e0689d27e098",
          "statusCode": "delivery_delivered",
          "statusCategory": "delivery",
          "statusMilestone": "delivered",
          "originCountryCode": "CN",
          "destinationCountryCode": "US",
          "trackingNumbers": [
            { "tn": "9400111202544843610364" },
            { "tn": "9400115901047177598206" }
          ],
          "delivery": {
            "estimatedDeliveryDate": "2021-03-04T18:00:00",
            "courierEstimatedDeliveryDate": {
              "from": "2021-03-04T17:00:00",
              "to": "2021-03-04T18:00:00"
            },
            "service": "Parcel Post"
          },
          "recipient": {
            "name": "John Doe",
            "address": "12515 Research Blvd",
            "postCode": "78738",
            "city": "Austin",
            "subdivision": "TX"
          }
        },
        "events": [
          {
            "eventId": "c6fbe883-49dc-7cba-48c4-46c6efd29db6",
            "trackingNumber": "9400111202544843610364",
            "eventTrackingNumber": "9400111202544843610364",
            "status": "Delivered to the addressee",
            "occurrenceDatetime": "2021-03-04T17:12:57",
            "order": 9,
            "location": "SAN RAFAEL, CA 94901",
            "sourceCode": "usps-tracking",
            "courierCode": "us-post",
            "statusCategory": "delivery",
            "statusCode": "delivery_delivered",
            "statusMilestone": "delivered"
          },
          {
            "eventId": "ecb7f9fe-eb7e-e9bf-406a-a9eb5d3b0853",
            "trackingNumber": "9400111202544843610364",
            "eventTrackingNumber": "9400111202544843610364",
            "status": "Out for Delivery",
            "occurrenceDatetime": "2021-03-04T10:12:57",
            "order": 8,
            "location": "SAN RAFAEL, CA 94901",
            "sourceCode": "usps-tracking",
            "courierCode": "us-post",
            "statusCategory": "delivery",
            "statusCode": "delivery_out_for_delivery",
            "statusMilestone": "out_for_delivery"
          },
          {
            "eventId": "d7d16234-280b-128f-4395-1abf79816837",
            "trackingNumber": "9400111202544843610364",
            "eventTrackingNumber": "9400111202544843610364",
            "status": "Arrived at Hub, Your item arrived at the hub.",
            "occurrenceDatetime": "2021-03-04T06:12:57",
            "order": 7,
            "location": "SAN RAFAEL, CA 94901",
            "sourceCode": "usps-tracking",
            "courierCode": "us-post",
            "statusCode": null,
            "statusCategory": null,
            "statusMilestone": "in_transit"
          },
          {
            "eventId": "52d54618-d602-eb91-496f-829302728146",
            "trackingNumber": "9400111202544843610364",
            "eventTrackingNumber": "9400115901047177598206",
            "status": "Package Received",
            "occurrenceDatetime": "2021-03-02T15:38:57",
            "order": 1,
            "location": "Beijing",
            "sourceCode": "usps-tracking",
            "courierCode": "us-post",
            "statusCode": "data_order_created",
            "statusCategory": "data",
            "statusMilestone": "info_received"
          }
        ],
        "statistics": {
          "timestamps": {
            "infoReceivedDatetime": "2021-03-02T15:38:57",
            "inTransitDatetime": "2021-03-02T19:24:57",
            "outForDeliveryDatetime": "2021-03-04T10:12:57",
            "failedAttemptDatetime": null,
            "availableForPickupDatetime": null,
            "exceptionDatetime": null,
            "deliveredDatetime": "2021-03-04T17:12:57"
          }
        }
      }
    ]
  }
}
```

Notes for the adapter:
- `occurrenceDatetime` is a "logistic date-time": local time, local with offset, UTC, or date only. Keep the raw string and sort by `order`.
- Add-on fields (e.g. `aiPredictiveDeliveryDate`) are *absent*, not `null`, when not subscribed.
- Use `courierEstimatedDeliveryDate` for `eta_start`/`eta_end`. `estimatedDeliveryDate` may be Ship24's own estimate, and SPEC goal 4 says we never invent an ETA. Confirm which field is courier-sourced before showing it.

## 8. Open questions for you
1. **Budget vs. fit.** Ship24 Free (10/mo, hard stop) for development, then $39/mo, or 17TRACK prepaid (cheaper, slower refresh)? It depends on how many non-USPS/UPS/FedEx/DHL packages you expect a month, and whether Porchlight stays single-user.
2. **`failed_attempt` / `delivery_attempted`**: map to `exception` (amber), or keep `in_transit` with a status_detail? SPEC's status list has no "attempted" value.
3. **TBA fallback**: should the aggregator ever be tried for TBA numbers when the Amazon importer has no data? Each try costs a credit and usually fails.

## Sources
- Ship24 docs: https://docs.ship24.com/getting-started · https://docs.ship24.com/trackers · https://docs.ship24.com/common-scenarios · https://docs.ship24.com/status · https://docs.ship24.com/rate-limiter · https://docs.ship24.com/couriers · https://docs.ship24.com/webhooks/overview · https://docs.ship24.com/webhooks/specification
- Ship24 OpenAPI spec (sample payload source): https://docs.ship24.com/assets/openapi/ship24-tracking-api.yaml
- Ship24 integration notes (idempotency, limits): https://docs.ship24.com/assets/ai/skills/ship24-tracking-api-integration/SKILL.md
- Ship24 pricing: https://www.ship24.com/pricing?product=s24-prod-track-api-shipment · https://help.ship24.com/en/article/ship24-pricing-and-plans-explained-425d9d · https://help.ship24.com/en/article/understanding-your-api-usage-and-quota-1crxjei · https://help.ship24.com/en/article/setting-up-webhooks-for-the-tracking-api-1iaiqes
- Ship24 coverage: https://www.ship24.com/couriers/axlehire-tracking · https://www.ship24.com/couriers/uniuni-tracking · https://www.ship24.com/shops/amazon-tracking · https://www.ship24.com/tracking-api/usps
- 17TRACK API docs v2.4: https://api.17track.net/en/doc?version=v2.4
- 17TRACK carrier list (JSON): https://res.17track.net/asset/carrier/info/apicarrier.all.json
- 17TRACK quota and status: https://help.17track.net/hc/en-us/articles/37575217580825-Plan-Details · https://help.17track.net/hc/en-us/articles/37575160271001-Quota-Deduction-Standards-and-Rules · https://help.17track.net/hc/en-us/articles/37471096573337-Understanding-Tracking-Status-Main-Status-Substatus · https://www.17track.net/en/brands/amazon
- TrackingMore v5 docs: https://www.trackingmore.com/docs/package-tracking-v5/start-tracking-automate-package-updates · https://www.trackingmore.com/docs/package-tracking-v5/webhook-overview · https://www.trackingmore.com/docs/package-tracking-v5/webhook-trigger · https://www.trackingmore.com/docs/package-tracking-v5/endpoint-mapping · https://www.trackingmore.com/docs/package-tracking-v5/migrating-from-api-v4-to-api-v5
- TrackingMore pricing and billing: https://www.trackingmore.com/pricing · https://support.trackingmore.com/en/article/trackingmore-billing-explained-credits-and-sms-fees-hychoa
- TrackingMore courier codes (widget list): https://www.trackingmore.com/embed_box.html
- AfterShip (reference): https://www.aftership.com/pricing/tracking · https://www.aftership.com/docs/tracking/2026-07/quickstart/rate-limit
- Reported competitor prices (secondary, from a competitor): https://www.ship24.com/blog/17track-vs-trackingmore · https://www.ship24.com/shops/17track-tracking
- Jitsu number formats (third party, unverified): https://lastscanned.com/lookup/axlehire
