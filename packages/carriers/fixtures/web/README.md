# Web adapter fixtures

Recorded or constructed replies for the server web adapters in
`src/adapters/web/`. Tests replay them through a fake fetch; nothing here is
fetched live.

Files that hold a whole reply rather than a JSON body (`captcha.json`,
`challenge.json`, `akamai-denied.json`, `ups/page.json`) use the shape
`{ status, contentType, body, setCookie? }`.

## Where each file comes from

From Universal Parcel Scraper (https://github.com/plhery/universal-parcel-scraper,
Apache-2.0), copied unchanged. Its own fixture notes say every identifier,
name and clock in them is made up:

- `amazon/swa-delivered.json` (carriers/amazon-shipping/fixtures/delivered.json)
- `amazon/history-expired.json` (carriers/amazon-shipping/fixtures/history-expired.json)
- `ontrac/delivered.json` (carriers/ontrac/fixtures/delivered.json)
- `uniuni/delivered.json` (carriers/uniuni/fixtures/delivered.json)
- `uniuni/edd.json` (carriers/uniuni/fixtures/estimate.json)
- `jitsu/delivered.json`, `jitsu/linehaul.json` (carriers/jitsu/fixtures/)
- `ups/out-for-delivery.json` (carriers/ups/fixtures/out-for-delivery.json)

From Porchlight's own probes on 2026-11-08 (docs/research/scraping.md), body
only, for numbers that do not exist:

- `amazon/not-found.json`, `dhl_ecommerce/not-found.json`, `ontrac/not-found.json`,
  `uniuni/not-found.json`, `jitsu/not-found.json`
- `ups/not-found.json`, trimmed to the fields the adapter reads, with the probed number swapped for a synthetic one

Constructed for Porchlight, following the field names above; every value is
made up and the `PRIVATE …` strings are placeholders that tests check never
reach a result:

- `amazon/out-for-delivery.json`, `amazon/malformed.json`, `amazon/captcha.json`
- `dhl_ecommerce/in-transit.json`, `dhl_ecommerce/delivered.json`,
  `dhl_ecommerce/two-packages.json` (shape from the reference's Webtrack tests)
- `ontrac/in-transit.json`
- `jitsu/challenge.json`
- `ups/page.json`, `ups/akamai-denied.json`
