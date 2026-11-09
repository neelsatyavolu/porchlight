# Device tracking fixtures

Copied from github.com/plhery/universal-parcel-scraper (Apache-2.0, see THIRD_PARTY_NOTICES.md), unchanged:

- `usps-timeline.html`, `usps-estimate.html`, `usps-history-table.html`: `carriers/usps/fixtures/timeline.html`, `estimate.html`, `in-transit.html`.
- `ups-out-for-delivery.json`: `carriers/ups/fixtures/out-for-delivery.json` (a `GetStatus` reply).
- `fedex-delivered.json`, `fedex-in-transit.json`, `fedex-held.json`: `carriers/fedex/fixtures/` (`track/v2/shipments` replies).

Their numbers, places and `PRIVATE …` values are synthetic.

From Porchlight's own probes on 2026-11-08 (made-up numbers, no personal data; headers and cookies dropped):

- `ups-not-found.json`: `GetStatus` for a number UPS doesn't know (error 504).
- `usps-interstitial.html`: the Akamai interstitial USPS serves before the tracking page.
- `fedex-access-denied.html`: Akamai's 403 for `api.fedex.com/track/v2/shipments`.

Written for Porchlight (SYNTHETIC in the file): `usps-not-found.html`, `usps-out-for-delivery.html`.
