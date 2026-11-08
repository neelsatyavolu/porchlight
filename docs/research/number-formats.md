# Tracking number formats and check digits

Phase 1 research for `packages/carriers` detection (SPEC §5). Written 2026-11-08.

## Sources

- **jkeen/tracking_number_data** (GitHub, MIT, © 2017 Jeff Keen). Checked out at commit `03af203` (v2.0.0, released 2026-08-15). Maintained: 2.0.0 rebuilt the USPS IMpb rules from USPS Publication 199, and 1.12/1.13 added FedEx ASTRA, GOFO and LaserShip 1LSCX. Each definition carries a regex, checksum parameters and valid/invalid test numbers. Unless noted, every example number below comes from its `test_numbers`.
- **UPS Tracking Support page** (ups.com, updated 2026-09-28): 1Z, T, 9- and 12-digit formats; Mail Innovations formats.
- **UniUni Platform API docs** (help.ship.uniuni.com, track endpoint): `^(UR\d{17}|URB\d{16})$`.
- **Third-party trackers** (Ship24, 17TRACK, lastscanned, Track91, ParcelPanel). Used only for UniUni and Jitsu, which publish no spec. Low confidence.
- **Flint fixtures** (`~/Documents/GitHub/flint/packages/core/src/tracking/__fixtures__`). Real, owner-supplied mail with two FedEx 12-digit numbers, two UniUni `UUS…` numbers and one 14-digit airline eTicket number (a useful negative). There are no USPS, UPS, DHL, TBA, OnTrac or Jitsu numbers. These numbers are referenced by file below and not copied here.

I checked every algorithm in this document with a script against the test numbers listed. The results are in "Verification" at the end.

## Normalization (before any rule)

1. Uppercase the input and remove spaces, hyphens and dots. The jkeen regexes allow `\s*` between characters. Normalizing first is simpler and lets the anchored regexes below stay readable.
2. LaserShip `1LS7…-1` has a meaningful `-1` suffix. Strip it, but keep the base number.
3. Anchor every regex as `^…$` on the normalized string. jkeen's regexes are unanchored because they are also used to scan free text.

## Checksum algorithms (pseudo-code)

`d[i]` is the digit at 0-based position `i`, counted left to right. `check` is the final character.

```text
mod10(seq, evenMul, oddMul, reverse=false):     # jkeen "mod10"
  chars = reverse ? reversed(seq) : seq
  total = Σ value(c) * (i even ? evenMul : oddMul)   for i, c in chars
  value(c) = c is digit ? int(c) : (ascii(c) - 3) mod 10   # UPS letter map: A=2 … H=9, I=0 …
  return (10 - total mod 10) mod 10

weighted11(seq, weights):                       # jkeen "sum_product_with_weightings_and_modulo"
  return (Σ int(seq[i]) * weights[i]) mod 11 mod 10

s10(serial8):                                   # UPU S10
  r = (Σ int(serial8[i]) * [8,6,4,2,3,5,9,7][i]) mod 11
  c = 11 - r
  return c == 10 ? 0 : c == 11 ? 5 : c

mod7(seq):                                      # DHL Express
  return int(seq) mod 7
```

## Per carrier

### USPS

| Format | Regex (normalized) | Check digit |
|---|---|---|
| IMpb, AI 94 (`usps_impb_n`), 22 digits; up to 30 with `420`+ZIP | `^(420\d{5}(\d{4})?)?94\d{20}$` (simplified) | `mod10(first n-1, 3, 1, reverse=true)` on the 22-digit serial, ignoring the `420ZIP` prefix |
| IMpb, AI 92/93/95 (`usps_impb_c`), 22–26 digits; up to 34 with `420`+ZIP+4 | `^(420\d{5}(\d{4})?)?9[235]\d{20,24}$` (simplified) | jkeen: `mod10(first n-1, 3, 1)`, with `reverse=false`, while `usps_impb_n` uses `reverse=true`. Weighting from the left or from the right gives the same result whenever the body has an odd length. The 22- and 26-digit serials have 21- and 25-digit bodies, so in practice the two never differ. Implement it as jkeen defines it. |
| Legacy AI 91 (`usps_legacy`) | `^(420\d{5}(\d{4})?)?(91)?\d{19}\d$` | prepend `91` if it is missing, then `mod10(…, 3, 1)` |
| 20 digit (`usps_20`, older Certified Mail and similar) | `^\d{20}$` | `mod10(first 19, 3, 1)` |
| S10 international | `^[A-Z]{2}\d{9}[A-Z]{2}$` | `s10(digits 1–8) == digit 9`. The suffix is the ISO country of the *origin* post (`US` = USPS-originated). |

Valid examples: `9400111206206406260787`, `420787459400111206206406260787`, `9405803699300124287899`, `9505 5110 6960 5048 6006 24`, `4201002334249200190132607600833457`, `9101 1234 5678 9000 0000 13`, `0307 1790 0005 2348 3741`, `RB123456785US`. Invalid: `9434611206206407667131`, `RB123456786US`.

Practical rule: the real-world majority is 22 digits starting `92`/`93`/`94`/`95`. Use the full jkeen lookahead regexes. Their lookaheads tie the mailer-ID length (6 or 9 digits) to the package-ID length, and that cuts false positives a lot.

### UPS

| Format | Regex | Check digit |
|---|---|---|
| 1Z (18 chars) | `^1Z[0-9A-Z]{6}[0-9A-Z]{2}[0-9A-Z]{7}\d$` | `mod10(chars 2–16, 1, 2)` using the letter map above (odd positions ×2) |
| Waybill / InfoNotice (T, H, J, K, V, A + 10) | `^[AHJKTV]\d{10}$` | `mod10(the 9 digits after the letter, 1, 2) == last` (jkeen; including the letter fails the published example `K1506235620`) |
| Mail Innovations: MI package ID | `^MI\d{6}[0-9A-Z]{1,22}$` | none (ups.com) |
| Mail Innovations: USPS number | 22–34 digits, an IMpb number (often `92748…`) | see USPS. Detect as **USPS**, because the final mile and tracking events are USPS. |
| Mail Innovations: sequence number | 18 digits | none. Do not detect: too ambiguous. |

Valid examples: `1Z5R89390357567127`, `1Z879E930346834440`, `1Z999AA10123456784` (widely published UPS sample), `K1506235620`. Invalid: `2Z5R89390357567127`, `K1506235622`.

UPS also lists bare 9- and 12-digit formats on ups.com. Do not detect them by format, because they collide with FedEx 12.

### FedEx

| Format | Regex | Check digit |
|---|---|---|
| Express 12 (`fedex_12`) | `^\d{12}$` | `weighted11(first 11, [3,1,7,3,1,7,3,1,7,3,1]) == d[11]` |
| Ground 15 (`fedex_ground`) | `^\d{15}$` | `mod10(first 14, 1, 3)` |
| Ground 96, 22 digits (`fedex_ground_96`) | `^96\d{20}$` | `mod10(d[7..20], 1, 3) == d[21]` (serial = last 14 before the check) |
| Ground GSN, 34 digits starting 96 (`fedex_ground_gsn`) | `^96\d{32}$` | `weighted11(d[20..32], [1,7,3,…]) == d[33]` |
| Express 34 (`fedex_34`) | `^[0-8]\d{33}$` | `weighted11(d[20..32], [1,7,3,1,7,3,1,7,3,1,7,3,1]) == d[33]` |
| ASTRA 32 (`fedex_astra_32`) | `^3\d{31}$` | `weighted11(d[16..26], [3,1,7,…]) == d[27]` |
| SSCC-18 (`fedex_ground_sscc_18`) | `^\d{18}$` | `mod10(first 17, 3, 1)`. Generic GS1. Do not use for detection. |

Valid examples: `986578788855`, `477179081230`, `799531274483`, `0414 4176 0228 964`, `9611020987654312345672`, `9622001900000000000000776632517510`, `1001921334250001000300779017972697`, `32971514560102447849175802862014`. Invalid: `996578788855`, `5682 8361 0012 732`.

**Important finding:** both real FedEx 12-digit numbers in the Flint fixtures (`fedex-on-the-way.txt`, `fedex-on-the-way-international.txt`) **fail** the Express-12 check digit, although FedEx's own mail calls them tracking IDs. jkeen 1.12 "loosened FedEx express pattern to match new number formats" (issue #117), which agrees with FedEx issuing 12-digit numbers outside the old check-digit scheme. So the FedEx-12 checksum must be a confidence booster (pass → high, fail → medium), **never** a reject.

### DHL Express

| Format | Regex | Check digit |
|---|---|---|
| Waybill, 10 digits (jkeen allows 10–11) | `^\d{10,11}$` | `mod7(all but last) == last` |
| Piece ID (JJD…, JVGL…) | `^J[A-Z]{2,3}\d{9,10}$` | none |

Valid examples: `3318810025`, `8487135506`, `1099255990`, `73891051146`, `JJD0099999999`. Invalid: `3318810010`.

Mod 7 passes 1 in 7 random numbers, and 10 digits is also a US phone number. Report DHL Express as **low** confidence unless context says DHL (sender, URL, or the word "DHL" near the number).

### DHL eCommerce (US)

| Format | Regex | Check digit |
|---|---|---|
| GM / LX / RX … (`dhl_ecommerce`) | `^(GM\|LX\|RX\|UV\|CN\|SG\|TH\|IN\|HK\|MY)[0-9A-Z]{10,39}$` (must contain a digit) | none |
| 420 + ZIP + 92… | IMpb, see USPS | USPS mod10 |
| 14 digit (`dhl_ecommerce_14`) | `^\d{14}$` | none. **Do not enable**: the airline eTicket in `united-booking-forwarded-twice.txt` matches it. |

Valid examples: `GM2951173225174494`, `GM295117494011169042`. Invalid: `GS295117494011169041`.

jkeen 2.0 removed its separate DHL eCommerce and FedEx SmartPost IMpb rules: "every number these matched still decodes, now as USPS". DHL eCommerce US and SmartPost hand off to USPS with ordinary IMpb numbers (for example `9261290357478304880413`, published by DCL Logistics), so detect those as **USPS** and track them with USPS. A GM number may need the aggregator. Note that `LX…` also overlaps S10 (`LX123456789US`), so run S10 first.

### Amazon Logistics

| Format | Regex | Check digit |
|---|---|---|
| TBA (US), TBC (CA), TBM (MX) | `^TB[ACM]\d{12}$` | none |

Valid examples: `TBA000000000000`, `TBC000000000000`, `TBM502887274000`. Invalid: `TBA50288727400A`.

The prefix makes this unambiguous. jkeen also has "Amazon International" `^[AFC]\d{10}$`, which collides with other carriers and is not useful for a US tracker, so skip it.

### OnTrac and LaserShip (one company since 2021)

| Format | Regex | Check digit |
|---|---|---|
| OnTrac C | `^C\d{14}$` | `mod10("4" + d[1..13], 1, 2) == d[14]` (C maps to 4) |
| OnTrac D | `^D\d{14}$` | `mod10("5" + d[1..13], 1, 2) == d[14]` (D maps to 5) |
| LaserShip 1LS7 (15) | `^1LS7[12]\d{10}$` | none |
| LaserShip 1LS7 (18) | `^1LS7[12]\d{2}01[1-4]\d{6}-1$` (keep `-1` for matching) | none |
| LaserShip 1LSCX (15) | `^1LSCX[0-9A-Z]{10}$` | none |
| LaserShip LX/LI/… | `^L[AIEHNX][1-3]\d{7}$` | none |

Valid examples: `C11031500001879`, `D10011354453707`, `1LS717793482164`, `1LS7119013618127-1`, `1LSCXVE005BUEFX`, `LX17635036`. Invalid: `C10000000000000`, `D10011345983012`.

`L[AIEHNX]\d{8}` is short. Give it medium confidence. All of these map to one `ontrac` carrier in Porchlight.

### UniUni

No published spec. The evidence:

- Flint fixtures (`flolab-uniuni-shipped*.txt`, `uniuni-*.txt`): `UUS` + 16 alphanumeric characters, 19 total, with a letter inside (e.g. shape `UUS63S…`).
- Ship24, 24hTrack and ParcelPanel give the same `UUS` + about 16 characters, digits or mixed. ParcelPanel also lists an older `UUS` + 13 digits form, and `UNIA` + 9 digits + optional `YQ`.
- The UniUni Platform API (official) gives `UR\d{17}` and batch IDs `URB\d{16}`.

Proposed rule: `^UUS[0-9A-Z]{13,16}$` (high), `^UR\d{17}$` (high), `^UNIA\d{9}(YQ)?$` (medium). There is no check digit. Public examples: `UUS6181780830420033`, `UUS5CS1789743195995` (Ship24), `UR06250000000000351` (UniUni API docs). Add another redacted fixture if a different shape shows up.

### Jitsu (formerly AxleHire)

No published format. Jitsu's recipient FAQ only says "enter your tracking ID". Third parties disagree:

- lastscanned: "Jitsu code: 12 or 16 letters and digits, mixed"; shipper number `SCD` + 16 (e.g. `SCD0000F00410922107`).
- Track91: `JT` + 14 digits (e.g. `JT68284018587518`) or an 8-character alphanumeric code.
- Others: "often starts with 10…" or `J…`.

Recommendation: **no format-only detection for Jitsu in v1.** Detect it from context only: sender domain `gojitsu.com` / `axlehire.com`, links to `recipient.gojitsu.com`, or the user picking it. Then track through the aggregator. If real mail arrives, add `^JT\d{14}$` and `^SCD[0-9A-Z]{16}$` as medium-confidence rules with fixtures. A rule that guesses mixed 12/16-character codes would match too much.

### Also worth having (in jkeen, seen on Temu/Shein mail)

GOFO Express `^GFUS\d{14}$` (e.g. `GFUS01011884214464`), no checksum.

## Ambiguity notes (ranked by how often they will bite)

1. **12 digits:** FedEx Express (checksum often fails on real numbers, see above), UPS InfoNotice 12-digit, Purolator 12. Return FedEx (medium, or high if the checksum passes). Return nothing else unless context names a carrier.
2. **10–11 digits:** DHL Express (mod 7), US phone numbers, order numbers. Low confidence, and require context in mail scanning.
3. **14 digits:** DHL eCommerce 14 (no checksum), airline eTickets, order numbers. Do not detect.
4. **15 digits:** FedEx Ground mod10 vs random numbers. Medium, or high with context.
5. **18 digits:** SSCC-18, UPS MI sequence, DHL eCommerce. Do not detect bare 18-digit numbers.
6. **20–22 digits starting 9x:** USPS vs FedEx Ground 96 (22 digits, `96` prefix) vs UPS MI / DHL eCommerce / SmartPost (USPS IMpb). The `96` prefix decides FedEx. Everything else in IMpb shape is USPS, and that is correct for tracking even when a consolidator printed the label. The mailer ID could later be used to show "via DHL eCommerce".
7. **34 digits:** FedEx 34 / GSN vs IMpb with `420`+ZIP+4 (34 digits starting `420`). A leading `420` means USPS. A leading `96` with 34 digits means FedEx GSN.
8. **S10 vs DHL eCommerce LX/RX:** a 2-letter + 9-digit + 2-letter shape is S10 (UPU post), checked with `s10()`. A non-US suffix means a foreign post. USPS tracks inbound S10 items once they are in the US, so the candidate is USPS (medium) plus the aggregator.

Confidence model for `detectCarrier`: **high** = unique prefix and checksum passes (1Z, IMpb 9x, TBA, OnTrac C/D, FedEx 96, S10); **medium** = unique prefix without a checksum (1LS, UUS, GM), or a checksum alone without a prefix (FedEx 15, FedEx 12 pass); **low** = length-only or a weak checksum (DHL 10, FedEx 12 fail).

## Recommendation: vendor the data, write the interpreter

**Vendor `tracking_number_data`'s `couriers/*.json`** (only the couriers we use: usps, ups, fedex, dhl, amazon, ontrac, lasership, s10, gofo) into `packages/carriers/vendor/tracking_number_data/`, pinned to a commit and tagged v2.0.0, with its `LICENSE` copied next to it and a one-line note in our README. MIT allows this; the only condition is keeping the copyright and permission notice.

Reasons:
- The hard parts (IMpb lookaheads from Pub 199, FedEx variants, OnTrac prefix mapping, per-format checksum constants) are maintained upstream, with test numbers we get for free as fixtures.
- The JSON uses only six checksum kinds (`mod10`, `mod7`, `s10`, `sum_product_with_weightings_and_modulo`, `luhn`, `mod_37_36`). We need the first four. An interpreter is about 100–150 lines of TS and the same in Swift.
- The SPEC wants one fixture file shared by the TS and Swift code. The jkeen `test_numbers` feed directly into `fixtures/numbers.json`.

Do **not** depend on the npm packages: `tracking_number_data@1.0.1` on npm is years stale, and `ts-tracking-number` (ISC) was last published in Feb 2024 and bundles pre-2.0 data.

**Hand-write a small overlay** (`packages/carriers/src/rules/local.ts` plus Swift twin, plus entries in `numbers.json`) for what jkeen lacks or gets wrong for us:
- UniUni (`UUS…`, `UR…`, `UNIA…`) and Jitsu (context only).
- UPS Mail Innovations `MI…`.
- The FedEx-12 policy (checksum as booster, not filter) and confidence levels. jkeen gives a match or no match and has no confidence.
- Disabling `dhl_ecommerce_14`, `amazon_international` and `fedex_ground_sscc_18` for detection.
- Mapping LaserShip to `ontrac`.

Porting notes: jkeen regexes use named groups (`(?<Name>…)`) and lookaheads. JS supports both. Swift `NSRegularExpression` (ICU) supports both too, and Swift `Regex` also accepts them. Strip the `\s*` fragments, or normalize the input and leave them in, since they are harmless.

Review upstream changes when updating the pin: v2.0.0 was a breaking rename of USPS IDs.

## Verification

A Python script in the session scratchpad (not committed) recomputed the check digits:
- Passed as expected: UPS ×4 (incl. `1Z999AA10123456784`), FedEx 12 ×2 public, FedEx 15 ×2, FedEx 96-22, FedEx 34, FedEx GSN, USPS IMpb ×5 (incl. two DHL eCommerce IMpb from DCL), DHL Express ×3, OnTrac C/D ×3, S10.
- Rejected as expected: `996578788855`, `568283610012732`, `3318810010`, `C10000000000000`, `RB123456786US`.
- Unexpected: both real FedEx 12-digit fixture numbers fail the Express-12 checksum. The Ship24 UPS-MI sample `92748999916505583204357863` (26 digits) fails the reverse mod10, so treat that site's example as unreliable. Do not use it as a fixture.
