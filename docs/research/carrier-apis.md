# Carrier tracking APIs: USPS, UPS, FedEx, DHL

Research for Phase 1 (SPEC §5). Checked 2026-11-08 against the carriers' own developer portals and published PDFs. Nothing here was verified with live calls: no accounts were created, and every value comes from documentation. Each section ends with its sources.

## Read this first: the access terms change the plan

SPEC §5 lists all four carriers as "free" primary providers. That holds for the API calls, but the terms of use do not line up with what Porchlight does: one person tracking packages that other people shipped to them.

| Carrier | Free to call? | Can Porchlight use it for packages other people shipped? |
|---|---|---|
| USPS | Free only for the shipper (owner of the Mailer ID in the barcode) or a label platform that shipper authorized | **No, not for free.** Since 2026-04-01, tracking a package whose Mailer ID you don't own needs a signed IP agreement and a monthly fee billed per tracking number. A request for an unauthorized Mailer ID fails. |
| UPS | Community tier is free, but creating an app needs a UPS.com login and a UPS shipper account | **Unclear, probably yes for a single user.** The Track product FAQ says "only users that plan to ship packages ... can use Track API". The UPS Technology Agreement counts inbound shipments to "You" as Tendered Shipments, so tracking your own incoming packages looks allowed. A multi-user service that tracks packages for other people falls under the API Access Agreement's "information intermediary" limits. A lawyer or UPS should confirm this. |
| FedEx | Free (Basic Integrated Visibility, 100k calls/day), but the developer org needs a FedEx account number (free to open) | **Probably yes.** No tracking-specific "your own shipments only" clause was found, but the license agreement bars giving the Materials to third parties for "multi-carrier systems" and reserves all tracking information to FedEx. Read §5 of the license agreement before relying on it. |
| DHL | Free, 250 calls/day to start; a higher limit needs a request | **Yes, with conditions.** Tracking Data may be used only "for Your own or Your customers' legitimate tracking purposes". It must be deleted 30 days after delivery, it can't be combined with ads, it must show "Delivered by Deutsche Post DHL Group", and anyone acting for the consignee has to get consent and pass the restrictions on. |

**Recommendation for the owner:** keep the aggregator (§5 fallback) as the **primary** source for USPS. Treat direct UPS and FedEx as optional upgrades that need the owner's own UPS/FedEx accounts and a terms check. DHL direct is fine for low volume if the attribution text and 30-day deletion are built in. This changes the table in SPEC §5, so the decision belongs to the owner.

## Status mapping summary

Porchlight statuses: `label_created`, `in_transit`, `out_for_delivery`, `available_for_pickup`, `delivered`, `exception`, `returned`, `unknown`.

| Porchlight | USPS (`statusCategory` / `eventCode`) | UPS (`activity.status.type` / `code`) | FedEx (`latestStatusDetail.derivedCode`) | DHL (`status.statusCode`) |
|---|---|---|---|---|
| label_created | Pre-Shipment, "USPS Awaiting Item"; GX, MA | `M`, `MV` (manifest) | `OC`, `IN` | `pre-transit` |
| in_transit | Accepted, On the Way, In Transit, Preparing for Delivery, International Transit; 03, 07, 10, OA, NT, T1… | `I`, `P` (pickup); `U` (update) keeps the current status | `PU`, `IT`, `AR`, `DP`, `AF`, `FD`, `PX`, `IX`, `CC`, `CP` | `transit` |
| out_for_delivery | Out for Delivery; `OF` | `I` with code `OT` ("Out for Delivery"); description check | `OD` | `transit` + description/remark text (no separate enum) |
| available_for_pickup | Available for Pickup, Available for Agent Pickup; 14, 16 | Delivered to UPS Access Point (comes as `D` or `X` with an access-point code; check the description) | `HP` (ready for recipient pickup), `HL` (hold at location) | `transit` + text such as "ready for pickup" |
| delivered | Delivered, Delivered to Agent; `01`, `OK` | `D` (final delivery event) | `DL` | `delivered` |
| exception | Alert, Delivery Attempt, Delivery Attempt: Action Needed; 02, 04, 05, 21, 22, 55, 56 | `X` | `DE`, `SE`, `DD`, `DY`, `CD`, `PD` | `failure` |
| returned | Returned to Sender, Returned to Shipper; `09`, `H8` | `RS` type, or `X` with a return-to-sender code | `RS` | `failure` with `returnFlag: true` on the shipment |
| unknown | not found, empty, or unrecognized | anything else | `CA` (cancelled) and anything else | `unknown` |

Rules that apply to every adapter:

1. Map structured codes first and descriptions second. Keep the raw carrier code and text in `events.description` so nothing is lost.
2. An unmapped code becomes `unknown` at the package level, but the event is still stored. Carriers add codes without notice; DHL says so in its client guidance.
3. Never make up an ETA (SPEC goal 4). Store only a field the carrier labels as estimated or scheduled, and clear it when the package is delivered.

---

## 1. USPS Tracking API 3.2 (`tracking/v3r2`)

**Version note.** SPEC names "Tracking API v3". The USPS catalog marks Tracking 3.0 as Legacy: "New users can no longer access", and it retires 2027-07-31. New integrations use **Tracking 3.2** (`/tracking/v3r2`). Web Tools (XML) was retired on 2026-01-25.

### Developer signup
1. Create or sign in to a USPS Business Account at the Customer Onboarding Portal, https://cop.usps.com.
2. In COP, create an App (My Apps → Developer Apps) and accept the USPS API Terms & Conditions.
3. Copy the Consumer Key and Consumer Secret; these are the `client_id` and `client_secret`.
4. The default product includes OAuth, Addresses, Prices, Locations, Service Standards, UserInfo and Tracking. A higher quota needs a service request at https://emailus.usps.com/s/usps-APIs.
5. **Tracking access (since 2026-04-01):** the Mailer ID (MID) in each package's barcode has to be registered to your account, or authorized for you by its owner. To track packages you didn't ship, sign an IP agreement through "Email Us → API Onboarding → IP Agreements", set up a funded Enterprise Payment Account (EPA), and send a payment token in each request. Billing is monthly, and each tracking number counts as one chargeable request (35 numbers in a batch = 35 charges).

### Auth flow
OAuth 2.0 client credentials.
```
POST https://apis.usps.com/oauth2/v3/token
Content-Type: application/json
{ "grant_type": "client_credentials", "client_id": "...", "client_secret": "..." }
```
The response contains `access_token`, `token_type: "Bearer"`, `issued_at`, `expires_in`, `scope`, `issuer` and `public_key`. Access tokens last **8 hours**; refresh tokens (auth-code grant only) last 7 days. Cache the token in KV and reuse it. Send it as `Authorization: Bearer <token>`.

### Endpoint and request
```
POST https://apis.usps.com/tracking/v3r2/tracking
Authorization: Bearer <token>
Content-Type: application/json

[
  { "trackingNumber": "9400111899223456789012",
    "mailingDate": "2026-11-01",          // optional, resolves duplicate numbers
    "destinationZIPCode": "94301",        // optional
    "includeVeriPoint": false }
]
```
A batch can hold 1 to 35 tracking numbers. The status can be 200, or 207 (multi-status) when some items fail.

### Response shape
These are the fields from the docs. The sample follows USPS/api-examples and the v3r2 subscription example.
```json
{
  "trackingNumber": "9400111899223456789012",
  "mailClass": "Priority Mail®",
  "mailClassCode": "PM",
  "originCity": "ORLANDO", "originState": "FL", "originZIPCode": "67890",
  "destinationCity": "...", "destinationState": "...", "destinationZIPCode": "...",
  "serviceTypeCode": "055",
  "status": "Delivered, Front Door/Porch",
  "statusCategory": "Delivered",
  "statusSummary": "Your item was delivered at the front door or porch at ...",
  "uniqueTrackingID": "...",
  "deliveryDateExpectation": { "expectedDeliveryDate": "2026-11-05", "endOfDay": "..." },
  "trackingEvents": [
    {
      "eventType": "Delivered, Front Door/Porch",
      "eventCode": "01",
      "eventTimestamp": "2025-02-07T12:55:12-05:00",
      "GMTTimestamp": "2025-02-07T17:55:12Z",
      "GMTOffset": "-5:00",
      "eventCity": "DETROIT", "eventState": "MI", "eventZIPCode": "12345", "eventCountry": "US",
      "reasonCode": "10", "actionCode": "A",
      "acceptanceTypeCategory": "Retail Point of Sale", "acceptanceTypeCategoryCode": "2"
    }
  ]
}
```
`trackingEvents` comes newest first.

### Status and event codes
`statusCategory` values under PTR2 (Tracking 3.2) are USPS Awaiting Item / Pre-Shipment, Accepted, On the Way (replacing "Moving Through Network", "In Transit from Origin Processing" and "Processing at Destination"), Preparing for Delivery, Out for Delivery, Delivered, Delivered to Agent, Delivery Attempt, Delivery Attempt: Action Needed, Available for Pickup, Available for Agent Pickup, International Transit, Alert, Returned to Sender and Returned to Shipper. v3r2 text can differ from USPS.com, which still runs on v3.

Common `eventCode` values (two characters): `GX` label created, awaiting item; `MA` pre-shipment info sent; `03` USPS in possession; `OA` accepted at origin; `07` arrived at Post Office; `10` processed through facility; `NT`/`TL` in transit to next facility; `OF` out for delivery; `01` delivered; `OK` international delivered with signature; `02` notice left; `NH` not home; `14` available for pickup; `16` available for pickup by returns agent; `04` refused; `05` undeliverable as addressed; `21` no such number; `22` insufficient address; `09` return to sender; `H8` foreign return to sender; `OH` on hold; `ME` held in customs. USPS's September 2026 known-issues list says events 01, 03, 06, 09, 10, 14, 32, 44, 54 and 73 have scripting errors in PTR2, so prefer `statusCategory` to `eventCode`.

Mapping: see the summary table. Use `statusCategory` first and `eventCode` second.

### ETA
`deliveryDateExpectation.expectedDeliveryDate`, an ISO date. Only in-transit items have it; it disappears once the item is delivered, returned or held. In January 2026 `scheduleDeliveryDate` was replaced by `expectedDeliveryDate`. Some items also get a time window; check the field names against the spec once there is access.

### Rate limits
Each API product has an hourly quota; the default is **60 calls per hour** per product. Going over returns HTTP 429. A higher quota needs a service request. Load tests in TEM need 72 hours' notice.

### Sandbox
TEM (Testing Environment for Mailers) is at `https://apis-tem.usps.com` and uses the same paths as production. It requires **production credentials**, so it can't be used before onboarding.

### Terms that restrict use
- The APIs are free "for valid USPS shipping/mailing use per USPS Terms and Conditions" (Web Tools migration FAQ). The terms themselves live inside COP.
- Since 2026-04-01, tracking access is checked against the barcode's MID. Free access is limited to shippers who own the MID and to label platforms holding the shipper's Merchant Access Token. Everyone else, including a "Paid Consumer Service Provider" that shows status to end consumers, needs a signed IP license agreement and pays a monthly fee. A request for an unauthorized MID "will result in a failure".
- **For Porchlight:** almost every package a person receives carries a merchant's MID, so direct USPS tracking is paid. Use the aggregator for USPS unless the owner signs an IP agreement.

### Sources
- https://developers.usps.com/getting-started
- https://developers.usps.com/Oauth
- https://developers.usps.com/trackingv3r2
- https://developers.usps.com/subscriptions-trackingv3r2
- https://developers.usps.com/apis?page=2 (Tracking 3.0 legacy and retirement notice)
- https://developers.usps.com/faq
- https://www.usps.com/business/web-tools-apis/onboarding-guide.pdf (60 calls/hour, 8 h token)
- https://www.usps.com/business/web-tools-apis/faqs-web-tools-to-usps-apis.pdf (free per T&C; Web Tools retired 2026-01-25)
- https://www.usps.com/business/api-access.htm (Tracking API Access Control, 2026-04-01)
- https://postalpro.usps.com/mnt/glusterfs/2026-02/Package%20Tracking%20API%20Access%20Control%20Changes%20Release%20Overview.pdf
- https://postalpro.usps.com/mnt/glusterfs/2026-03/Tracking%20Access%20Control.pdf
- https://stage-postalpro.usps.com/mnt/glusterfs/2026-05/USPS%20PTR%20Modernization%20Overview%20external%20version%2014.pdf (statusCategory changes)
- https://github.com/USPS/api-examples (token and tracking samples)
- https://developers.usps.com/sites/default/files/2024-10/USPS%20API%20Cloud%20Enrollment.pdf (TEM)
- Event code list (secondary source, mirrors USPS codes): http://docs.shippingapi.pitneybowes.com/reference/tracking-codes.html

---

## 2. UPS Track API

### Developer signup
1. Create a UPS.com login and **a UPS shipper account**; the UPS FAQ says both are needed for a client ID and secret. Opening a shipper account is free but takes payment details.
2. Go to https://developer.ups.com → My Apps → Add App, choose a usage tier (Community is free, one Community app per user), and add the Tracking product.
3. Copy the Client ID and Client Secret.

### Auth flow
OAuth 2.0 client credentials. The UPS docs describe this grant as "when the integration owner is also the UPS shipper".
```
POST https://onlinetools.ups.com/security/v1/oauth/token
Authorization: Basic base64(client_id:client_secret)
x-merchant-id: <shipper number>          // optional
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
```
The response has `access_token`, `token_type`, `expires_in` (about 4 hours; check this) and `issued_at`. An auth-code flow also exists, for acting on behalf of another UPS user.

### Endpoint and request
```
GET https://onlinetools.ups.com/api/track/v1/details/{inquiryNumber}
    ?locale=en_US&returnSignature=false&returnMilestones=false&returnPOD=false
Authorization: Bearer <token>
transId: <unique id per request>          // required
transactionSrc: porchlight                // required
```
Other endpoints: `GET /api/track/v1/reference/details/{referenceNumber}` and `GET /api/track/v1/shipment/details/{inquiryNumber}` (every package in a shipment). The API takes one tracking number per call. Data is kept for 120 days.

### Response shape
This is the UPS Postman sample, trimmed.
```json
{
  "trackResponse": {
    "shipment": [{
      "inquiryNumber": "1Z1442YY7229014688",
      "package": [{
        "trackingNumber": "1Z1442YY7229014688",
        "currentStatus": { "code": "SR", "description": "Your package was released by the customs agency.",
                           "simplifiedTextDescription": "Delivered", "statusCode": "003", "type": "X" },
        "deliveryDate": [{ "type": "DEL", "date": "20220126" }],
        "deliveryTime": { "type": "DEL", "startTime": "", "endTime": "163000" },
        "activity": [
          { "location": { "address": { "city": "PARAMUS", "stateProvince": "NJ", "countryCode": "US" }, "slic": "0761" },
            "status": { "type": "D", "description": "DELIVERED ", "code": "F4", "statusCode": "011" },
            "date": "20220126", "time": "163000", "gmtDate": "...", "gmtTime": "...", "gmtOffset": "..." },
          { "status": { "type": "M", "description": "Shipper created a label, UPS has not received the package yet. ",
                        "code": "MP", "statusCode": "003" },
            "date": "20220126", "time": "151641" }
        ],
        "packageCount": 1
      }]
    }]
  }
}
```
Dates are `YYYYMMDD` and times are `HHMMSS`, in local time. Use `gmtDate`/`gmtTime` when present.

### Status and event codes
`status.type` is the main signal. `M`/`MV` = manifest (label created). `I` = in progress (in transit). `P` = pickup. `U` = update, usually a changed scheduled delivery. `X` = exception. `D` = delivery information, which per UPS covers "loaded on delivery vehicle, out for delivery, delivered". `RS` = returned to shipper.

Because `D` covers more than final delivery, decide on `status.code` and the description. `OT` = "Out for Delivery" (UPS Track Alert example, `type: "I"`). `F4` / `statusCode: "011"` = delivered. `MP` / `"003"` = label created. Access-point delivery and return-to-sender share codes across types. The full code list is in the UPS "API Codes" appendix (https://developer.ups.com/api/reference/tracking/api-code), which the scraper could not render. Build the adapter's code table from that page plus recorded fixtures.

### ETA
`package.deliveryDate[]` entries with `type`: `SDD` (scheduled delivery date), `RDD` (rescheduled delivery date) or `DEL` (actual delivered date). `deliveryTime` holds `startTime`/`endTime`, with `type` such as `EOD` (end of day) or `DEL`. Use RDD over SDD when both are present, and treat neither as an ETA after `DEL`.

### Rate limits
Monthly quotas per app reset every 31 days. **Community (free): Track 90,000 per month** according to the pricing table, but the same page's FAQ gives "up to 40,000 Track API calls within 31 days" as its example. Plan for 40,000 until UPS clarifies. Power User costs USD 3,500 a month (Track 12,000,000) and is meant for non-shippers. Enterprise is free for shippers with custom limits. Each API also has an unpublished per-minute spike limit that returns 429 / `10429 Too Many Requests` until the next minute.

### Sandbox
CIE (Customer Integration Environment) is at `https://wwwcie.ups.com/api`, with the same paths. UPS says CIE sample requests can be tried "without the need to create an Application". CIE returns canned data for test numbers.

### Terms that restrict use
- The Track API product FAQ says "Only users that plan to ship packages manifested, tendered, and delivery by UPS can use Track API."
- The UPS Technology Agreement defines "Tendered Shipment" to include shipments "by a third party ... for delivery to You" (inbound). §7.2 says you may not aggregate the Information or build products from it except as the agreement permits.
- The UPS API Access Agreement (v052024) limits Tracking API data to the developer's internal purposes and to sharing with a person who has a "bona fide interest in the shipment" (such as the consignee). It bans acting as or using an "Engine" (an information intermediary) without UPS's written consent, and UPS may add fees at any time.
- The UPS mobile app EULA, which is a different product but shows UPS's position, allows tracking "solely to track shipments tendered by or for such User".
- **For Porchlight:** a personal app where the signed-in user tracks their own inbound packages fits "bona fide interest / inbound shipment". Serving many users from one UPS app is closer to an intermediary. Get confirmation before a public launch.

### Sources
- https://developer.ups.com/tag/Tracking?loc=en_US (base URLs, endpoints, 120-day retention)
- https://developer.ups.com/api/reference/tracking/product-info ("only users that plan to ship"; free for shippers)
- https://developer.ups.com/pricing?loc=en_US (tiers, Track quotas, spike arrest)
- https://developer.ups.com/support (UPS.com login + shipper account; 10429)
- https://developer.ups.com/tag/OAuth-Client-Credentials
- https://github.com/UPS-API/api-documentation/blob/main/Tracking.yaml (OpenAPI: SDD/RDD/DEL, status schema)
- https://www.postman.com/ups-api/ups-apis/request/10yfq5s/tracking-example-request (sample response)
- https://developer.ups.com/tag/UPS-Track-Alert (status type meanings, `OT` example)
- https://www.ups.com/assets/resources/webcontent/en_US/ups_api_access_agreement.pdf
- https://assets.ups.com/adobe/assets/urn%3Aaaid%3Aaem%3Ac271a615-2207-4626-8507-521abe266d37/original/as/uta-en-GLOBAL.pdf (UPS Technology Agreement)
- https://www.ups.com/us/en/support/shipping-support/legal-terms-conditions/end-user-agreement

---

## 3. FedEx Track API ("Basic Integrated Visibility")

FedEx renamed the Track API to **Basic Integrated Visibility** in June 2025. The endpoints did not change.

### Developer signup
1. Sign up at https://developer.fedex.com and create an **Organization**.
2. Add a FedEx account number to the org. A personal fedex.com account is free to open, and at least one account is needed to move a project to production.
3. Create a project that contains **only** Basic Integrated Visibility; it can't share a project with other APIs. Accept the Developer Portal License Agreement and the EULA.
4. Copy the API Key (client ID) and Secret Key. The same keys work on the sandbox right away; production needs the project moved to Production.

### Auth flow
OAuth 2.0 client credentials.
```
POST https://apis.fedex.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=...&client_secret=...
```
The response has `access_token`, `token_type: "bearer"`, `expires_in` (3600 s) and `scope`. Don't send a `scope` parameter. Cache the token for its full hour; FedEx penalizes clients that fetch a new token too often (see rate limits). Calls must come from the server; FedEx doesn't support CORS.

### Endpoint and request
```
POST https://apis.fedex.com/track/v1/trackingnumbers
Authorization: Bearer <token>
Content-Type: application/json
X-locale: en_US
x-customer-transaction-id: <uuid>    // optional

{
  "includeDetailedScans": true,
  "trackingInfo": [
    { "trackingNumberInfo": { "trackingNumber": "123456789012" },
      "shipDateBegin": "2026-10-20", "shipDateEnd": "2026-11-08" }   // optional; FedEx reuses numbers
  ]
}
```
A request can hold up to 30 numbers. Set `includeDetailedScans: true`, or `scanEvents` comes back empty.

### Response shape
This is the FedEx docs sample, trimmed.
```json
{
  "transactionId": "...",
  "output": {
    "completeTrackResults": [{
      "trackingNumber": "123456789012",
      "trackResults": [{
        "trackingNumberInfo": { "trackingNumber": "128667043726", "carrierCode": "FDXE", "trackingNumberUniqueId": "..." },
        "latestStatusDetail": {
          "code": "DL", "derivedCode": "DL", "statusByLocale": "Delivered", "description": "Delivered",
          "scanLocation": { "city": "...", "stateOrProvinceCode": "...", "countryCode": "US" },
          "ancillaryDetails": [{ "reason": "...", "reasonDescription": "...", "action": "...", "actionDescription": "..." }]
        },
        "dateAndTimes": [
          { "type": "ESTIMATED_DELIVERY", "dateTime": "2026-11-05T00:00:00-06:00" },
          { "type": "ACTUAL_DELIVERY", "dateTime": "..." },
          { "type": "ACTUAL_PICKUP", "dateTime": "..." },
          { "type": "SHIP", "dateTime": "..." }
        ],
        "estimatedDeliveryTimeWindow": { "window": { "begins": "2019-05-07T08:00:07", "ends": "2019-05-07T12:00:07" } },
        "standardTransitTimeWindow": { "window": { "ends": "..." } },
        "scanEvents": [{
          "date": "2026-11-04T09:12:00-06:00",
          "eventType": "PU", "eventDescription": "Picked Up",
          "derivedStatusCode": "PU", "derivedStatus": "Picked up",
          "exceptionCode": "", "exceptionDescription": "",
          "scanLocation": { "city": "...", "stateOrProvinceCode": "...", "postalCode": "...", "countryCode": "US" },
          "locationType": "FEDEX_FACILITY",
          "delayDetail": { "status": "DELAYED", "type": "WEATHER", "subType": "SNOW" }
        }],
        "serviceDetail": { "type": "FEDEX_GROUND", "description": "..." },
        "error": { "code": "TRACKING.TRACKINGNUMBER.NOTFOUND", "message": "..." }
      }]
    }]
  }
}
```
Errors can appear per number in `trackResults[].error` while the HTTP status is still 200. The docs say that if the top-level notifications report a failure, the rest of the payload should be ignored. Shipments using FedEx Authenticated Delivery (FAD) return `TRACKING.AUTHENTICATEDDELIVERY.ERROR` and no status.

### Status and event codes
Map `latestStatusDetail.derivedCode` for the package and `scanEvents[].derivedStatusCode` for each event. Codes seen in the docs and samples: `OC` order created / shipment information sent; `IN` initiated; `PU` picked up; `DO` dropped off; `AR` arrived; `DP` departed; `IT` in transit; `OD` out for delivery; `DL` delivered; `DE` delivery exception; `SE` shipment exception; `CA` cancelled; `RS` return to shipper; `HL` hold at location; `HP` ready for recipient pickup; `DY`/`DD` delay; `CD` clearance delay; `CC` cleared customs; `CP` clearance in progress; `AE`/`AO` arriving early/on time (event types added in 2021). The longer `code` list (AA, AF, FD, OF, PX, IX…) is from the legacy FedEx Web Services docs; use the REST docs' "Track status codes" appendix plus recorded fixtures to confirm it. `delayDetail.status` is ON_TIME, EARLY or DELAYED.

### ETA
In order of preference:
1. `estimatedDeliveryTimeWindow.window.{begins,ends}`, a time window. It is only filled for some destinations and services (US/CA/BE/DE/NL on Express, Ground or Home Delivery), not for hold-at-location, appointment or Date Certain deliveries.
2. `dateAndTimes[type=ESTIMATED_DELIVERY]`.
3. `standardTransitTimeWindow.window.ends`. This is the standard transit time, not a prediction, so Porchlight should **not** show it as an ETA (SPEC goal 4).

FedEx says the EDD is only returned after the package is tendered.

### Rate limits
- Track capability: **100,000 requests per day** per project, shared by all 6 track endpoints. Going over returns 429 "Daily transaction quota exceeded" until 00:00 GMT.
- **1,400 transactions per 10 seconds** per project. Going over returns 429 for the rest of the window.
- OAuth token abuse is tracked per public IP: a burst threshold, plus an average of 1 hit/second sustained over 2 minutes. Breaking it gives 403 for 10 minutes, and the penalty extends if the calls continue.
- Business rules: at most 30 numbers per call, track only as often as needed, and drop delivered packages from batches.

### Sandbox
`https://apis-sandbox.fedex.com` for both `/oauth/token` and `/track/v1/...`. The sandbox returns canned data for documented test numbers. FedEx asks that no performance testing be run in either environment.

### Terms that restrict use
- Developer Portal License Agreement (Aug 2021 v1.0): you may not give the Materials to a third party for building into a "multi-carrier system"; third parties may use FedEx Technology only under the EULA; FedEx owns all FedEx tracking information; FedEx may monitor applications; you may not assign the license.
- No clause was found that limits tracking to your own shipments. A FedEx account number is needed for production, and paid products (Advanced Integrated Visibility webhooks) are billed to it.
- **For Porchlight:** the single-user case looks fine. Read §2 and §5 of the license agreement before shipping to other users. A multi-carrier consumer app could be read as a "multi-carrier system".

### Sources
- https://developer.fedex.com/api/en-us/catalog/track.html (100k/day; key features; EDTW changelog)
- https://developer.fedex.com/api/en-us/catalog/track/v1/docs.html (FAD error, EDTW, business rules, 30 numbers)
- https://developer.fedex.com/api/en-cy/catalog/track/v1/docs.html (response sample fields)
- https://developer.fedex.com/api/en-us/catalog/authorization/docs.html (OAuth, 60-min token, sandbox/prod hosts)
- https://developer.fedex.com/api/en-us/guides/ratelimits.html (quotas, 1,400/10 s, OAuth threshold penalties)
- https://developer.fedex.com/api/en-bs/guides/best-practices.html
- https://developer.fedex.com/api/en-us/support.html (org, account number, BIV in its own project)
- https://developer.fedex.com/api/en-us/announcements/Introduction_to_Integrated_Visibility_Portfolio.html (rename)
- https://developer.fedex.com/api/en-us/legal/fdpla.html (license agreement)
- https://trafficparrot.com/sandbox-ready-made-mocks/fedex/fedex-catalog-track-api.html (secondary: full sample with derivedStatusCode values DO/IT/DL)

---

## 4. DHL Shipment Tracking – Unified API

### Developer signup
1. Register at https://developer.dhl.com. Fill in a real company name; DHL reviews for "bot-like" profiles, and an email domain that matches the company helps.
2. On the Shipment Tracking – Unified page, click "Get Access", create an App and add the API. DHL reviews the request by hand.
3. At most 2 instances of the API per user (one for test, one for production); a third is likely to be refused.
4. In My Apps → app → Credentials, click "Show" to see the Consumer Key. That key is the API key.
5. For a higher limit, use "Request Upgrade" on the app. DHL may ask for a DHL account number and details about the use case.

### Auth flow
An API key in a header, with no OAuth: `DHL-API-Key: <Consumer Key>`. The documented `demo-key` returns only mocked responses.

### Endpoint and request
```
GET https://api-eu.dhl.com/track/shipments
    ?trackingNumber=7777777770
    &service=express                 // optional hint
    &requesterCountryCode=US         // optional
    &originCountryCode=DE            // optional
    &recipientPostalCode=94301       // optional, unlocks more detail on some services
    &language=en                     // optional
    &offset=0&limit=5                // optional
DHL-API-Key: <key>
Accept: application/json
```
`service` values include `express`, `parcel-de`, `ecommerce`, `ecommerce-europe`, `ecommerce-iberia`, `ecommerce-tr`, `dgf`, `freight`, `parcel-nl`, `parcel-pl`, `parcel-uk`, `sameday`, `svb` (replaces `post-de`), `express-acs` and `dsc`. Leave it out to let DHL search every service. If a number doesn't match directly, DHL also searches piece IDs and references.

### Response shape
This is the DHL docs sample, trimmed.
```json
{
  "shipments": [{
    "id": "00340434292135100197",
    "service": "parcel-de",
    "origin": { "address": { "countryCode": "DE" } },
    "destination": { "address": { "countryCode": "DE", "addressLocality": "Bonn" } },
    "status": {
      "timestamp": "2024-07-02T07:21:00",
      "location": { "address": { "addressLocality": "..." } },
      "statusCode": "transit",
      "status": "PO",
      "description": "Being delivered.",
      "remark": "Being delivered."
    },
    "estimatedTimeOfDelivery": "2024-07-02",
    "estimatedTimeOfDeliveryRemark": "...",
    "estimatedDeliveryTimeFrame": { "estimatedFrom": "2024-07-02T09:00:00", "estimatedThrough": "2024-07-02T10:30:00" },
    "product": { "productCode": "09", "productName": "DHL KLEINPAKET" },
    "returnFlag": false,
    "details": { "proofOfDeliverySignedAvailable": false, "totalNumberOfPieces": 1, "pieceIds": ["..."] },
    "events": [ { "timestamp": "...", "location": { "address": { "addressLocality": "..." } },
                  "statusCode": "transit", "status": "PO", "description": "...", "remark": "..." } ]
  }],
  "possibleAdditionalShipmentsUrl": ["..."]
}
```
Errors use RFC 7807 problem JSON: `{ "title": "No result found", "status": 404, "detail": "..." }`. Timestamps may or may not carry a timezone offset; without one, the time is local to the event. Parcel DE has been adding offsets since mid-2026.

### Status and event codes
`statusCode` is the normalized enum and the main signal: `pre-transit`, `transit`, `delivered`, `failure`, `unknown`. `status` is a code specific to each service (`PO` and `ZU` for Parcel DE; three-digit codes such as `600` for eCommerce; codes like `24-600` for Freight). `description` and `remark` are free text that DHL changes without notice; DHL itself advises using structured codes instead of matching text.

DHL has no enum value for out-for-delivery or ready-for-pickup. To get Porchlight's finer statuses, either map the per-service `status` codes (Parcel DE `PO` = being delivered, i.e. out for delivery) or leave them as `in_transit`. `returnFlag: true` marks a rejected or returned shipment, which maps to `returned`. DHL warns that enums may gain values, and unknown ones should be treated as undefined (`unknown`).

### ETA
`estimatedTimeOfDelivery`, an ISO date or date-time; it has been filled for eCommerce since April 2024. `estimatedDeliveryTimeFrame.{estimatedFrom,estimatedThrough}` is a window. `estimatedTimeOfDeliveryRemark` is free text.

### Rate limits
Initial service level: **250 calls per day, at most 1 call every 5 seconds**. Older copies of the page say 1 call per second; the current English page says 5 seconds. DHL calls this "intended for initial development and not suitable for production". More can be granted per use case through "Request Upgrade". Going over returns HTTP 429.

### Sandbox
None separate: `https://api-eu.dhl.com/track/shipments` serves both sandbox and production. The `demo-key` and the portal's "Try Now" return mocked data, so tests can use recorded fixtures.

### Terms that restrict use ("Legal Terms – specifics for the use of Tracking Data")
- Tracking Data (status, ETA and the tracking number itself) is Confidential Information. It can't be passed to third parties, analyzed or used for competitive purposes without DHL's written consent, except as allowed below.
- It may be used only if the tracking number was obtained lawfully, and only "solely for Your own or Your customers' legitimate tracking purposes".
- It can't be combined with advertising or shown in a way that looks like advertising.
- **It must be deleted 30 days after delivery** unless otherwise agreed.
- **"Delivered by Deutsche Post DHL Group"** must be shown as text wherever the data is presented to recipients or customers.
- An app acting for a shipper or consignee must get consent (sender, and consignee if personal data is included), tell users that their data goes to third parties, and pass these restrictions on to them. DHL may ask for proof and may audit.
- **For Porchlight:** the `events` table and package archive need a DHL-specific purge 30 days after `delivered_at`, and the package detail view needs the attribution line.

### Sources
- https://developer.dhl.com/api-reference/shipment-tracking?language_content_entity=en (access steps, auth, environment, rate limits, legal terms, changelog)
- https://developer.dhl.com/tracking?language_content_entity=de (sample response, 1 call/s on the older copy)
- https://developer.dhl.com/getting-started/get-a-higher-rate-limit?language_content_entity=en
- https://developer.dhl.com/api-reference/shipment-tracking#reference-docs-section (OpenAPI: statusCode enum, service enum, query parameters)

---

## Open questions for the owner

1. USPS direct tracking needs a paid IP agreement for packages Porchlight users receive. Should the aggregator be the only USPS source, or should we price an IP agreement?
2. UPS needs the owner's UPS shipper account to create the app, and its terms cover the consignee case but not a multi-user service. Is direct UPS still wanted, or should UPS go through the aggregator until the terms are confirmed?
3. Is a FedEx account (free) acceptable for the Basic Integrated Visibility project?
4. DHL's 250 calls/day is enough for one person with polling as in SPEC §5, but production use needs an upgrade request, which may ask for a DHL account number. Is that OK?
5. For DHL, a 30-day post-delivery purge and the "Delivered by Deutsche Post DHL Group" line need to go into the spec.
