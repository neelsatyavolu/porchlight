# Third-party notices

Porchlight includes material from the projects below. Each ported file also
names its source in a header comment.

## Universal Parcel Scraper

- Source: https://github.com/plhery/universal-parcel-scraper
- License: Apache License 2.0; the full text is in LICENSES/Apache-2.0.txt
  (also at https://www.apache.org/licenses/LICENSE-2.0)
- Upstream NOTICE: "Universal Parcel Scraper contains code extracted from
  plhery/delivery-tracker. Core code is distributed under Apache-2.0; see LICENSE."
- What we use: carrier status mappings, response parsers and test fixtures,
  ported to TypeScript (packages/carriers) and Swift (PorchKit). Only its
  Apache-2.0 core is used; nothing from its AGPL-3.0 `trawl/` folder or its
  CAPTCHA models.
- Changes: rewritten to Porchlight's types and status set; the files are
  listed below.

Ported files:

- packages/carriers/src/adapters/web/amazon.ts (from carriers/amazon-shipping/adapter.ts and status.ts)
- packages/carriers/src/adapters/web/dhl_ecommerce.ts (from carriers/dhl-ecommerce/adapter.ts and status.ts)
- packages/carriers/src/adapters/web/ontrac.ts (from carriers/ontrac/parser.ts and status.ts)
- packages/carriers/src/adapters/web/uniuni.ts (from carriers/uniuni/parser.ts, status.ts and estimate.ts)
- packages/carriers/src/adapters/web/jitsu.ts (from carriers/jitsu/adapter.ts, parser.ts and status.ts)
- packages/carriers/src/adapters/web/ups.ts (from carriers/ups/adapter.ts and status.ts)
- packages/carriers/fixtures/web/: amazon/swa-delivered.json, amazon/history-expired.json,
  ontrac/delivered.json, uniuni/delivered.json, uniuni/edd.json, jitsu/delivered.json,
  jitsu/linehaul.json and ups/out-for-delivery.json, copied unchanged from the matching
  carriers/*/fixtures/ files (see packages/carriers/fixtures/web/README.md)
- apps/apple/Packages/PorchKit/Sources/PorchKit/DeviceTracking/USPSTrackingPage.swift (from carriers/usps/adapter.ts)
- apps/apple/Packages/PorchKit/Sources/PorchKit/DeviceTracking/UPSTrackStatus.swift (from carriers/ups/adapter.ts)
- apps/apple/Packages/PorchKit/Sources/PorchKit/DeviceTracking/FedExShipments.swift (from carriers/fedex/adapter.ts)
- apps/apple/Packages/PorchKit/Sources/PorchKit/DeviceTracking/CarrierTime.swift (US state zones from
  core/time/index.ts; place patterns from carriers/usps/clock.ts)
- apps/apple/Packages/PorchKit/Tests/PorchKitTests/DeviceTracking/Fixtures/: usps-timeline.html,
  usps-estimate.html, usps-history-table.html, ups-out-for-delivery.json, fedex-delivered.json,
  fedex-in-transit.json and fedex-held.json, copied unchanged from carriers/usps/fixtures/,
  carriers/ups/fixtures/ and carriers/fedex/fixtures/ (see that folder's README.md)

<!-- Builders: add one line per ported or copied file, e.g.
- packages/carriers/src/adapters/web/ontrac.ts (from carriers/ontrac/...)
-->
