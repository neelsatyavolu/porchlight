# Carrier tracking pages: scraping research (2026-11-08)

The owner won't pay for the USPS or UPS APIs. FedEx production keys need a paid shipping account, and Ship24's free tier covers 10 packages a month. So Porchlight reads each carrier's own public tracking feed. Probes were run from the owner's Mac at a gentle rate. The main reference is github.com/plhery/universal-parcel-scraper (Apache-2.0), which covers every carrier here except Amazon. Credit it in the code wherever its mappings are ported.

## Recommendations

| Carrier | Path | What the probe showed |
|---|---|---|
| USPS | device (hidden WKWebView) | Akamai interstitial, then a heavy obfuscated JS challenge. The data exists only in the HTML. |
| UPS | device. A server attempt works from a home IP but is fragile. | Plain HTTP worked 2 out of 2 times from the Mac. Untested from Cloudflare. |
| FedEx | device (riskiest) | The data API returns 403 "Access Denied" from Akamai, even for a real number. |
| DHL Express | no scraping; use the free DHL API (250/day, pending approval) | Blocked with a 403 that says the data is "not for integration". |
| DHL eCommerce US | server | Anonymous JSON. |
| Amazon Logistics (TBA) | server, through the tracker API. The device reads the TBA from the signed-in order page. | Anonymous JSON. |
| OnTrac / LaserShip | server | Anonymous JSON. A 404 problem-details body means not found. |
| UniUni | server | JSON with a fixed public site key. Old numbers look the same as invalid ones. |
| Jitsu / AxleHire | server | Anonymous JSON. A specific Jersey 404 body means not found. |

**Consequence for SPEC §5.** USPS, UPS and FedEx can't be polled by the Worker cron. The native app runs the hidden web view and posts what it observes to the API. iOS background refresh runs rarely, so the 15-minute "out for delivery" rate for these carriers only holds while the app is open, or while the Mac app or menu-bar item is running.

**Terms.** USPS bans robots and scrapers. UPS forbids "automated inquiry devices, robots … scripts", although it allows tracking shipments "tendered by or for You". FedEx forbids "non-authorized scripting technologies". Amazon's Conditions of Use bar data-extraction tools, although track.amazon.com is public. DHL says its website data is not for integration. No tracking-specific clause was found for DHL eCommerce, OnTrac, UniUni or Jitsu. The owner accepted this risk on 2026-11-08: low volume, own packages only, best effort.

## Hidden WKWebView setup (USPS, UPS, FedEx; Amazon order page)

- Use one persistent `WKWebsiteDataStore` for carriers. This is not the Amazon store. Don't clear it between lookups, because Akamai's `_abck` and `bm_sz` cookies score better when they persist.
- Set `applicationNameForUserAgent = "Version/18.6 Safari/605.1.15"`.
- Keep the view in the view hierarchy: 1×1 or offscreen, alpha 0.01. A detached view has its timers throttled and the Akamai scripts stall.
- Inject a `WKUserScript` at `.atDocumentStart` with `forMainFrameOnly: false`. It wraps `fetch` and `XMLHttpRequest`, and posts `{url, status, body}` to a message handler when the URL matches the carrier's API. Fall back to the DOM. USPS is DOM-only.
- Stop at the first matching capture, or after 25 s (report `transient`). Run one lookup per carrier at a time, at least 5 s apart, and at most about 20 per carrier per hour. Never solve a CAPTCHA; offer "Open in Safari" instead.

## USPS (device)

- **Page:** `https://tools.usps.com/go/TrackConfirmAction?tLabels={n}`, which redirects to `/tracking/?tLabels={n}`. Up to about 35 numbers can be passed, comma-separated.
- **Still challenged:** `.track-bar-container` is missing. The `#trackingNum` text must equal the requested number.
- **Not found:** "Tracking Not Available" inside `.latest-update-banner-wrapper .banner-header`. Only that wrapper counts.
- **ETA:** `.expected_delivery`, with weekday, day, month and year in child elements, optionally followed by "by 9:00pm". An out-for-delivery event reading "Expected Delivery Between 1:15pm and 4:15pm" gives a window on that event's day.
- **Events:** `.tb-step` cards (`.tb-status-detail`, `.tb-date`, `.tb-location`). Collapsed cards already hold the full history. Skip undated placeholder cards and "See All". The fallback is `.tracking_history_container` rows.
- **Status** (text of `.tb-status-detail`, first match wins):

  | Text | Status |
  |---|---|
  | starts with "Delivered" | `delivered` |
  | "Available for Pickup", "Available for Agent Pickup", "Held at … Office/Depot" | `available_for_pickup` |
  | "Out for Delivery" | `out_for_delivery` |
  | "Return to Sender", "Refused", "Returned to Shipper" | `returned` |
  | "Alert", "Notice Left", "Delivery Attempted", "Insufficient Address", "No Access" | `exception` |
  | "Pre-Shipment", "Label Created", "Label Printed", "USPS Awaiting Item" | `label_created` |
  | "Accepted", "Arrived", "Departed", "In Transit", "Processed", "Awaiting Delivery", "Picked Up by Shipping Partner" | `in_transit` |
  | "Tracking Not Available" | `unknown` |

- **Times:** there is no offset, so the ETA is date-only.
- **Polling:** at most every 30 min, every 60 min after a failure, and pause 5 min after 3 challenges in a row.

## UPS (device first; server attempt allowed)

- **Page:** `https://www.ups.com/track?loc=en_US&tracknum={n}&requester=ST/trackdetails`. It sets the cookies `X-CSRF-TOKEN`, `X-XSRF-TOKEN-ST`, `AKA_A2`, `bm_s`, `bm_so` and `bm_sz`.
- **API:** `POST https://webapis.ups.com/track/api/Track/GetStatus?loc=en_US`.
  - **Headers:** `Content-Type: application/json`, `Origin: https://www.ups.com`, `Referer: <page URL>`, the page cookies, and `X-XSRF-TOKEN` set to the value of the `X-XSRF-TOKEN-ST` cookie.
  - **Body:** `{"Locale":"en_US","TrackingNumber":["<lowercase>"],"Requester":"st/trackdetails","returnToValue":""}`.
  - Without the cookies the call returns 401.
- **Response:** `trackDetails[]`, each with:
  - `errorCode`, `errorText`, `trackingNumber`, `packageStatus`
  - `progressBarType` (ManifestUpload, FirstUPSPossession, InTransit, OutForDelivery, Delivered or Exception)
  - `isDelivered`, `isDeliveredToUAP`, `returnNumbers`
  - `scheduledDeliveryDateDetail{monthCMSKey:"cms.stapp.dec", dayNum}`, which has no year
  - `packageStatusTime`
  - `shipmentProgressActivities[{date "MM/DD/YYYY", time, location, activityScan, actCode, gmtDate "YYYYMMDD", gmtTime "HH:MM:SS", gmtOffset "-06:00"}]`
- **Not found:** `errorCode` is set (for example "504"), or there are no events.
- **Package status** (`progressBarType`, lowercased):

  | `progressBarType` | Status |
  |---|---|
  | `manifestupload` | `label_created` |
  | `firstupspossession`, `intransit` | `in_transit` |
  | `outfordelivery` | `out_for_delivery` |
  | `delivered` | `delivered`, or `available_for_pickup` when `isDeliveredToUAP` is true |
  | `exception` | `exception` |

  `returnNumbers` being set, or "Return…" in the text, means `returned`.
- **Event status** (`actCode`):

  | `actCode` | Status |
  |---|---|
  | `MP` | `label_created` |
  | `OF`, `OT` | `out_for_delivery` |
  | `9E`, `FS`, `KB`, `KD`, `KE` | `delivered` |
  | `2Q`, `ZP`, `5G`, `S7` | `available_for_pickup` |
  | `48`, `49`, `G3`, `5R` | `exception` |
  | anything else | `in_transit` |

- **Event time:** `gmtDate` and `gmtTime` plus `gmtOffset` give an instant.
- **ETA:** date-only. For the year, use this year unless the result is more than 7 days in the past; then use next year.

## FedEx (device)

- **Page:** `https://www.fedex.com/fedextrack/?trknbr={n}`, which redirects to `/wtrk/track/`. It is an Angular shell.
- **API capture:** the page calls `POST https://api.fedex.com/track/v2/shipments` with a Bearer token from `/auth/oauth/v2/token`. Capture the response whose URL matches `track/v2/shipments`. If nothing arrives within 10 s, fill `input[name=trackingnumber]` and submit the form.
- **Response:** `output.packages[]`, each with:
  - `trackingNbr`, `keyStatus`, `keyStatusCD`
  - `estDeliveryDt`, `displayEstDeliveryDt`, `actDeliveryDt`
  - `errorList[{code}]`
  - `scanEventList[{date "YYYY-MM-DD", time, gmtOffset, scanLocation, status, statusCD}]`
- **Not found:** an `errorList[].code` matching `/TRACKINGNUMBER|NOTFOUND/`.
- **Status** (`keyStatusCD`):

  | `keyStatusCD` | Status |
  |---|---|
  | `OC`, `IN` | `label_created` |
  | `PU`, `IT`, `AR`, `DP`, `AF`, `FD`, `PX`, `IX`, `CC`, `CP`, `DO` | `in_transit` |
  | `OD` | `out_for_delivery` |
  | `HL`, `HP` | `available_for_pickup` |
  | `DL` | `delivered` |
  | `DE`, `SE`, `DD`, `DY`, `CD`, `PD` | `exception` |
  | `RS` | `returned` |
  | `CA` and anything else | `unknown` |

- **ETA:** `estDeliveryDt` at local midnight is date-only. A window with offsets is timed.
- **Back off** for 1 h after any 403.

## DHL Express

Don't scrape it. Use `adapters/dhl.ts` with the free key (250 calls a day, 1 call per 5 s). The terms require the line "Delivered by Deutsche Post DHL Group" and deleting the data 30 days after delivery.

## DHL eCommerce US (server)

- **API:** `POST https://api.dhlecs.com/webtrack/v4/tracking` with body `{"trackedValue":"<n>","offset":0,"locale":"en-US"}`. No token is needed.
- **Not found:** `{"total":0,"limit":10,"offset":0,"packages":[]}`.
- **Found:** `packages[]`, each with:
  - `trackingId`, `status`
  - `estimatedDeliveryDate "YYYY-MM-DD"`
  - `dspName` (USPS, DAI_DIRECT or MIRROR)
  - `events[{primaryEventId, primaryEventDescription, date, time, timeZone "ET|CT|MT|PT", location}]`
- **Parsing:** require exactly one package. Skip the "EN ROUTE" row that has no location, and drop rows that repeat the same id, date and time.
- **Status** (`primaryEventDescription`):

  | Description | Status |
  |---|---|
  | "LABEL CREATED", "MANIFEST DATA RECEIVED", "EN ROUTE TO DHL ECOMMERCE" | `label_created` |
  | "OUT FOR DELIVERY" | `out_for_delivery` |
  | "READY FOR COLLECTION" | `available_for_pickup` |
  | "DELIVERED" | `delivered` |
  | "RETURNED TO SENDER" | `returned` |
  | "DELIVERY ATTEMPT FAILED", "Carrier exception" | `exception` |
  | "PROCESSED", "DEPARTURE", "ARRIVAL", "TENDERED", "ACCEPTED BY USPS", "CUSTOMS" | `in_transit` |

- **Times:** map `timeZone` to an IANA zone.
- **ETA:** date-only.
- **Hand-off:** when `dspName` is `USPS`, USPS delivers the last leg.

## Amazon Logistics (server, by TBA)

- **API:** `GET https://track.amazon.com/api/tracker/{TBA}` with a browser User-Agent and `Referer: https://track.amazon.com/`. No login is needed.
- **Response:** `progressTracker` and `eventHistory` are JSON strings nested inside the JSON.
- **Not found:**
  ```json
  {"errors":[{"errorCode":"TRACKING_ID_NOT_FOUND"}],"summary":{"status":null,"metadata":{}},"expectedDeliveryDate":null,"trackerSource":"UNKNOWN"}
  ```
- **Found (from open-source parsers; confirm with the first real TBA):** `eventHistory[{eventCode, eventTime ISO, statusSummary{localisedStringId}, location{city, stateProvince, countryCode, postalCode}}]`, plus `summary.metadata.expectedDeliveryDate`.
- **Status** (`eventCode`):

  | `eventCode` | Status |
  |---|---|
  | `CreationConfirmed`, `LabelCreated` | `label_created` |
  | `PickupDone`, `Received`, `InTransit`, `Departed`, `ArrivedAtSortCenter`, `ArrivedAtDeliveryCenter`, `Sorted`, `Transferred`, `InTransitToCustomer` | `in_transit` |
  | `OutForDelivery` | `out_for_delivery` |
  | `Delivered` | `delivered` |
  | `DeliveryAttempted`, `AttemptFail`, `Undeliverable`, `Exception` | `exception` |
  | `Held` | `available_for_pickup` if a pickup location is named, otherwise `exception` |
  | `Refused`, `Returned`, `OutForReturn`, `ReturnReceived` | `returned` |

- **Times:** event times are instants. The ETA is date-only unless it carries an offset.
- **Order page selectors (device, signed in):**
  - Container: `div.pt-main-container` or `#pt-page-container-inner`. The error page is `#errorPageContainer`.
  - TBA: `.pt-delivery-card-trackingId`, text "Tracking ID: …".
  - Carrier: `.tracking-event-carrier-header`, text "Shipped with UPS".
  - Status: `#primaryStatus`, `.pt-promise-main-slot`, `.pt-promise-details-slot`.
- **Email links:** order emails link through `gp/r.html?U=`. URL-decode `U` to get `progress-tracker/package?orderId&shipmentId&packageIndex`.

## OnTrac / LaserShip (server)

- **API:** `GET https://webtrack.ontrac.com/PackageServices/tracking/{n}`. LaserShip `1LS…` numbers use the same endpoint.
- **Not found:** a 404 problem-details body. Treat it as not found only when the number format is valid.
- **Found:** `Packages[{Tracking, UtcExpectedDeliveryDateTime, Events[{EventCode, Status, EventShortDescription, ZonedEventDateTime, City, State}]}]`. Ignore `Consignee`, `PodText` and the photo fields, which hold personal data. Require exactly one `Tracking` that equals the requested number.
- **Status** (`EventCode`):

  | `EventCode` | Status |
  |---|---|
  | `EXRL` | `label_created` |
  | `ORIG`, `LOAD`, `SFCT`, `NFRP` | `in_transit` (`NFRP` is the hand-off to another carrier) |
  | `OFDL` | `out_for_delivery` |
  | `DLVD` | `delivered` |
  | `BCLD`, `UTLV`, `NDMI`, `ONHD` | `exception` |
  | anything else | `unknown`, keeping the text |

- **Times:** a `ZonedEventDateTime` without an offset is local time.
- **ETA:** `UtcExpectedDeliveryDateTime` is UTC; midnight means date-only.

## UniUni (server)

- **API:** `GET https://tracking-service-api.uniuni.ca/tracking/trackinguniuninew?id={n}&key=SMq45nJhQuNR3WHsJA6N&source=web`. The key is a public constant from UniUni's site JS, so keep it in config.
- **Optional ETA:** `POST https://sj.uniexpress.ca/version2/orders/edd_information` with `{"tnos":[…]}`.
- **Not found or expired:** `{"status":"SUCCESS","err_code":1,"data":{"invalid_tno":"<n>","valid_tno":[]}}`.
- **Found:** `valid_tno[{tno, is_master, spath_list[{state:int, description_en, city, province, dateTime{timezone, offsetByGMT, localTime, ts}}]}]`. Events come oldest first, so reverse them, and take the time from `dateTime`.
- **Status** (`state`):

  | `state` | Status |
  |---|---|
  | `190` | `label_created` |
  | `199`, `195`, `200`, `255`, `204`, `217` | `in_transit` |
  | `202` | `out_for_delivery`, but `label_created` when the text says "on its way to UniUni" |
  | `211` | `exception` |
  | `203` | `delivered` |

- **ETA:** only from the EDD call, and only when `edd_enabled`. A bare date is date-only; start, end and timezone together are timed.

## Jitsu / AxleHire (server)

- **Codes:** taken from email links `tracking.gojitsu.com/{code}`, `recipient.gojitsu.com/{code}` and the old `*.axlehire.com` addresses. A code is 16 lowercase letters and digits.
- **API:** `GET https://api.recipient.gojitsu.com/delivery/{code}`. Don't follow redirects.
- **Not found:** `{"servlet":"jersey","message":"Not Found","url":"/delivery/<code>","status":"404"}`.
- **Challenge:** a Cloudflare challenge page (`_cf_chl_opt`, `cf-turnstile`) means `transient`.
- **Found:** `shipment{status, timezone, dropoff_earliest_ts, dropoff_latest_ts, returnShipment}`, `settings{hide_delivery_datetime}`, and `outbound_events[{type, signal, description, ts}]`, newest first. Ignore the driver, customer, access-code and photo fields.
- **Status** (`type.signal`):

  | Signal | Status |
  |---|---|
  | `PLANNING.CREATED`, `PLANNING.GEOCODED` | `label_created` |
  | `INBOUND.*_SCAN`, `INBOUND.RECEIVED_OK`, `OTHER.IN_TRANSIT`, `OUTBOUND.PICKUP_SCHEDULED`, `OUTBOUND.RETURN_SUCCEEDED` | `in_transit` |
  | `OUTBOUND.PICKUP_SUCCEEDED`, `OUTBOUND.DROPOFF_EN_ROUTE`, `OUTBOUND.DROPOFF_READY`, `OUTBOUND.DROPOFF_REATTEMPTING` | `out_for_delivery` |
  | `OUTBOUND.DROPOFF_SUCCEEDED` | `delivered` |
  | `OUTBOUND.DROPOFF_FAILED`, `*.DAMAGED`, `INBOUND.LOST`, `OUTBOUND.UNDELIVERABLE`, `OUTBOUND.RETURN_FAILED`, `OUTBOUND.DISPOSABLE`, `PLANNING.UNSERVICEABLE` | `exception` |

  `returnShipment` being true means `returned`. Don't use `milestone`.
- **ETA:** a timed window from `dropoff_earliest_ts` to `dropoff_latest_ts`. Leave it out when `hide_delivery_datetime` is set, when the package is delivered, or once the window has passed.

## Polling limits (per package)

| Feed | Out for delivery | In transit | Label created | After a failure |
|---|---|---|---|---|
| USPS (device) | 30 min | 2 h | 6 h | 60 min |
| UPS, FedEx (device) | 20–30 min | 2 h | 6 h | 60 min |
| DHL (free API) | 30 min | 2 h | 6 h | Retry-After; 250/day budget |
| Server feeds | 15 min | 1–2 h | 6 h | exponential backoff, up to 2 h |

Send at most about 20 requests per carrier per hour from one IP or device, and stop once a package is delivered.
