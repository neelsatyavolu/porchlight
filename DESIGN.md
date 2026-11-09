# Porchlight design system

Porchlight is a list you glance at a few times a day: what arrives today, what's late, what came. The interface stays out of the way. It is a black canvas with hairlines, one blue accent for the thing arriving now, and two status colors.

This file wins over `~/DESIGN.md` ("Blackletter", v2) for this project. It keeps Blackletter's tokens, fonts, radii and rules, and changes four things for an app you check rather than read:

1. **Status colors.** Green for delivered and amber for a problem are the only colors besides the accent (§4).
2. **Mono for numbers you might copy.** Tracking numbers, order ids and pairing codes are set in Geist Mono (§3).
3. **Smaller display.** Inside the app, Geist Serif appears only at 40–48px, on sign-in and whole-page empty states. The marketing site (`site/`) uses the full Blackletter scale.
4. **A narrower column.** The app is one 720px column; nothing sits beside it.

Tokens live in `apps/web/src/styles/tokens.css`. `site/` copies that file at build time. Components use the variables, never raw hex.

## 1. Principles

1. **Arrival day first.** The list answers "what's coming today?" before anything else. Grouping by day (§6) beats sorting by status.
2. **Honest status.** Show what the carrier last said and when it said it. Never invent an ETA, never round "Last checked 3 h ago" into "Updated". If the carrier gave no date, say "No date yet".
3. **Blue means today.** The accent marks out-for-delivery packages, links, focus and the one primary action. Keep it under about 3% of a screen.
4. **Flat.** Depth comes from luminance steps and 1px hairlines. No shadows, gradients, glass or glow.
5. **Quiet when nothing is happening.** Empty states are a sentence and at most one button.

## 2. Color tokens

Dark is the default. Light follows the system, and `<html data-theme="light"|"dark">` overrides it. Values are Blackletter's.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#000000` | `#FCFCFD` | Page background, nav |
| `--card` | `#0A0A0C` | `#FFFFFF` | Inputs, sheets, cards |
| `--elev` | `#111114` | `#F4F5F7` | Ghost buttons |
| `--deep` | `#06060A` | `#0A0A0C` | Code wells (dark in both themes; the site only) |
| `--ink` | `#FCFDFF` | `#0A0A0C` | Titles, primary text |
| `--body` | white 86% | black 82% | Secondary text, prose |
| `--mute` | `#A1A4A5` | `#5F6366` | Meta, captions, group labels, placeholders |
| `--stone` | `#464A4D` | `#C4C7CA` | Disabled only; older timeline dots |
| `--line` | white 6% | black 6% | Row dividers, nav border |
| `--line-2` | white 14% | black 12% | Inputs, ghost buttons, sheets, carrier badges |
| `--hover` / `--active` | white 4% / 7% | black 4% / 7% | Row hover, pressed, current nav item |
| `--accent` | `#4C8DFF` | `#2F6FE0` | See principle 3 |
| `--tint` | accent 12% | accent 8% | Selected row |
| `--ring` | accent 55% | accent 45% | 3px input focus ring |
| `--ok` | `#3DD68C` | `#14915A` | Delivered |
| `--warn` | `#FFC53D` | `#B7791F` | Exception, returned |
| `--danger` | `#FF4D5E` | `#D92D3F` | Destructive buttons, form errors. Never a package status |
| `--scrim` | black 60% | ink 32% | Behind a sheet |

## 3. Typography

Fonts are self-hosted from the `geist` npm package (OFL): the web app bundles them through Vite, the site serves them from `/fonts/`. Nothing loads from Google.

| Role | Face | Size / line | Weight | Use |
|---|---|---|---|---|
| Display | Geist Serif | 48 / 48 | 400 | Sign-in wordmark. `-0.02em`, `text-wrap: balance` |
| Display small | Geist Serif | 40 / 40 | 400 | Whole-page empty states. Never below 40px |
| Heading | Geist | 22 / 31 | 500 | Detail title, page titles |
| Heading small | Geist | 18 / 24 | 500 | Sheet titles, inline empty states |
| Row title | Geist | 15 / 22 | 500 | Package row line 1 |
| Body | Geist | 15 / 23 | 400 | Everything else |
| Body small | Geist | 14 / 20 | 400 | Row meta, ETA, nav links |
| Label | Geist | 13 / 18 | 500 | Group headers ("Today"), sentence case, `--mute` |
| Caption | Geist | 12 / 18 | 400 | Hints, "Last checked", badges |
| Mono | Geist Mono | 13 / 20 | 400 | Tracking numbers, order ids, pairing codes. Ligatures off, `0.02em` tracking |

Numbers (times, dates, counts) use `font-variant-numeric: tabular-nums` (`.num`). Emphasis is a color step (`--body` to `--ink`), not bold. No uppercase tracked labels.

Tracking numbers are shown whole in the detail view and copyable with one click. In rows, only the last 4 characters appear, and only when the package has no title or merchant ("UPS ···4784").

## 4. Status

Eight normalized statuses come from `@porchlight/carriers`. `apps/web/src/lib/status.ts` holds the labels and tones; native apps mirror it.

| Status | Label | Tone | Dot |
|---|---|---|---|
| `out_for_delivery` | Out for delivery | out (`--accent`) | filled |
| `available_for_pickup` | Ready for pickup | out (`--accent`) | filled |
| `delivered` | Delivered | delivered (`--ok`) | filled |
| `exception` | Problem | exception (`--warn`) | filled |
| `returned` | Returned to sender | exception (`--warn`) | filled |
| `in_transit` | In transit | neutral (`--mute`) | filled |
| `label_created` | Label created | neutral | hollow ring: nothing has moved |
| `unknown` | No update yet | neutral | hollow ring |

Rules:
- Status color appears only on the 8px dot (and the latest timeline dot). Text stays `--ink` / `--body`; never color a whole row, badge or background by status.
- The carrier's own words (`statusDetail`) go in the meta line next to our label, so "Problem" is always followed by what the carrier said.
- `--danger` red is for destructive actions, never for a package.

## 5. Components

Implemented in `apps/web/src/components/`. Builders compose these; new primitives go here, not inside a page.

- **Button** (`variant`: primary, accent, ghost, danger; `size`: md 36px, sm 28px; 8px radius; `busy` shows a 1px progress line along the bottom edge and disables the button). Primary is ink-on-canvas, at most one per view. Use accent instead of primary only for the single most important action on a screen (Add package on an empty list). Never primary and accent side by side. Ghost for everything secondary. Danger is red text on a hairline, for Delete only.
- **Input** (40px, 8px radius, `--card` fill, `--line-2` border; focus: accent border plus 3px `--ring`). Always has a label (`hideLabel` keeps it for screen readers). `mono` for tracking numbers and codes. `error` turns the border red and is announced.
- **StatusDot**: 8px circle per §4. Alone it carries the label as its accessible name; `withLabel` shows the text.
- **CarrierBadge**: the carrier's name in 12px `--mute` text inside a 20px chip with a `--line-2` border and 6px radius. No carrier logos or brand colors.
- **Row**: the list row (§6). Slots: `leading`, `title`, `trailing`, `meta`, `trailingMeta`. A link with `to`, a button with `onClick`.
- **EmptyState**: `size="page"` (Geist Serif 40px title, 96px top padding) or `inline` (18px Geist title). One or two sentences, at most one action.
- **Sheet**: modal panel, 480px centered with a 12px radius on desktop, a bottom sheet under 600px. Scrim, Escape and the close button dismiss it; focus starts in the content, stays inside, and returns to the opener. Footer buttons sit right-aligned.

Icons: inline SVG, 16px, 1.5px stroke, `currentColor`. No emoji anywhere.

## 6. Package list and detail

### Package row

```
 ●  Headphones ............................ Today
    Out for delivery · On vehicle, Oakland    [UPS]
```

- 64px minimum height, 12px 16px padding, `--line` divider below. Hover: `--hover`. The row is a link to `/app/p/:id`.
- **leading**: `StatusDot`, centered on the title line.
- **title**: `title`, else `merchant`, else `"<Carrier> ···<last 4>"`. One line, ellipsis.
- **trailing**: the ETA phrase, tabular, `--body`:
  - out for delivery: "Today"; with a time window from the carrier, "By 8:00 PM"
  - ETA today / tomorrow: "Today" / "Tomorrow"
  - within 6 days: weekday ("Thursday")
  - later: "Nov 21"
  - ETA in the past and not delivered: "Was due Nov 3" in `--mute`
  - no ETA: "No date yet" in `--mute`
  - delivered: "Delivered 2:14 PM" today, "Delivered Tue" this week, else "Delivered Nov 3"
- **meta**: our status label, then ` · ` and `statusDetail` when present, in `--mute`. One line, ellipsis.
- **trailingMeta**: `CarrierBadge`.
- Archived packages are left out of the main list.

### Arrival-day grouping

Groups appear in this order, and empty groups are hidden: **Today, Tomorrow, This week, Later, Delivered**.

The day of a package comes from `etaEnd ?? etaStart`. When `etaDateOnly` is true those are calendar dates (`"2026-11-10"`): use the date as it is, in every time zone, and never convert it to an instant, or a Nov 10 delivery lands on Nov 9 for everyone in the Americas. A date-only ETA has no time of day, so it never shows "By 8:00 PM" or a time window. When `etaDateOnly` is false the values are instants: the day is their local calendar day in the browser's time zone (docs/API.md, "The Package object").

| Group | Rule |
|---|---|
| Today | `out_for_delivery` or `available_for_pickup`; or ETA day is today; or ETA is in the past and not delivered |
| Tomorrow | ETA day is tomorrow |
| This week | ETA day is 2 to 6 days from today |
| Later | ETA further out, or no ETA |
| Delivered | `delivered`, newest `deliveredAt` first |

Order inside a group: out for delivery first, then by ETA, then by `updatedAt` newest first. `exception` and `returned` follow the same date rules; their amber dot is enough to stand out.

Group headers are Label style (13px, 500, `--mute`), 32px tall and sticky under the nav, with the count after the name in tabular figures ("Today 3").

### Detail (`/app/p/:id`)

Top to bottom in the 720px column:

1. Back link "Packages" (14px, `--mute`, chevron).
2. Title in Heading style (22px). Click to rename inline; Enter saves through `PUT` with `title`.
3. `StatusDot withLabel` and the ETA sentence: "Arriving Thursday, Nov 12", "Delivered Tuesday at 2:14 PM", or "No delivery date from UPS yet".
4. Facts as label/value rows with `--line` dividers: Carrier (`CarrierBadge`), Tracking number (Mono, Copy ghost button sm), Merchant, Order (Mono), Source ("Added by hand", "From Amazon", "From Flint", "Shared"), Last checked ("14 min ago", absolute time in a `title` tooltip).
5. Items (Amazon): name and quantity rows. No product images in v1; the image URLs point at Amazon's CDN and would leak views to Amazon.
6. Timeline (below).
7. Actions: Refresh (ghost; a 429 shows "Checked recently. Try again in 2 min" from `Retry-After`), Archive / Unarchive (ghost), Delete (danger, confirms in a Sheet).

### Timeline

- Newest first, grouped by local day with a Label header ("Sun, Nov 8").
- Each event: an 8px dot on a 1px `--line-2` rail at the left, then the description (15px; `--ink` for the newest, `--body` for the rest), then location and time on one line in 14px `--mute` ("Oakland, CA · 9:12 AM").
- The newest dot takes the package's status tone; older dots are `--stone`.
- Times are local. If the carrier's offset differs from the browser's, append the carrier's zone abbreviation when the browser can name it.

## 7. Other screens

### Sign-in (`/signin`, `/signin/verify`)
Centered 360px column, left-aligned text. "Porchlight" in Display (48px Geist Serif), one line of body below ("Sign in to see your packages on any device."), an Email input and a primary "Email me a link" button. After sending: "Check your email" (Heading), the address in `--ink`, and a 6-digit Mono code input ("Or enter the code from the email"). The verify page shows "Signing you in" while it trades the token, and on 401 "This link has expired or was already used." with a link back.

### Add (`/app/add`)
Paste field (Mono, autofocus, `inputmode="text"`, `autocapitalize="characters"`). As the user types, `detectCarrier` from `@porchlight/carriers` shows candidates as selectable chips (Row-height radio list on mobile); a single high-confidence match is preselected. Optional Title field. Accent button "Track package". A 409 duplicate goes straight to the existing package with a one-line note "You're already tracking this."

### Settings (`/app/settings`)
Sections with Heading small titles and Row-based lists: Account (email, Sign out ghost, Delete account danger in a Sheet that asks for the word "delete"), Devices (every signed-in session from `GET /v1/sessions`: "iPhone", "Mac" or "Web browser", with "Last active 3 h ago · Version 1.0 (7) · Signed in Nov 2" as meta; the current one says "This browser" and has no button, the others have a ghost sm "Sign out"), Connections (Flint: one "Connect Flint" button opens Flint with a `flint://` link and shows "Opening Flint…", then "Connected to Flint on <Mac>" when the token appears; under it "Flint not opening? Get Flint" and a "Use a code instead" disclosure with the `ABCD-EFGH` code in 22px Mono and its expiry; on iPhone the row only explains that Flint runs on the Mac; paired tokens listed with "Last used" and Revoke), Amazon ("Connect Amazon in the Porchlight app on your Mac or iPhone. The web can't sign in to Amazon for you.").

### Empty and error states

| Where | Title | Body | Action |
|---|---|---|---|
| List, no packages (page) | Nothing on the way | Paste a tracking number, or connect Amazon in the Mac or iPhone app. | Add a package (accent) |
| List, only delivered | (no empty state; show the Delivered group) | | |
| Detail, unknown id | This package isn't here | It may have been deleted on another device. | Back to packages |
| Detail, no events yet | No scans yet | UPS hasn't reported this number. Porchlight checks again within the hour. | none |
| Sync failed, data shown | (inline line above the list, `--mute`) | Couldn't refresh. Showing what we had at 9:41 AM. | Try again (text button) |
| Sync failed, nothing shown (page) | Couldn't reach Porchlight | The error message | Try again |

### Voice
Sentence case. Buttons say what happens ("Track package", "Email me a link", "Revoke"). No exclamation marks, no "Oops", no emoji. Errors say what failed and what happens next.

## 8. Layout and motion

- One column, max 720px, 24px gutters (16px under 600px). Nav 56px, sticky, `--canvas` with a `--line` border: wordmark left, Packages / Add / Settings right.
- 4px grid: 4, 8, 12, 16, 24, 32, 48, 96.
- Radii: 6px badges, 8px controls, 12px sheets and cards, full for dots.
- Motion: 150ms `cubic-bezier(.2,0,0,1)` for hover and focus, 250ms for a sheet entering (8px rise and fade). No spinners over content; loading is a blank space that fills, or the button's 1px progress line. `prefers-reduced-motion` makes all of it instant.

## 9. SwiftUI mapping (Phase 3)

The Apple apps keep native chrome and borrow the content styling.

**Fonts.** System fonts (SF Pro) in all chrome: navigation bars, toolbars, tab bars, menus, `Form` and `List` section headers, buttons, alerts, sheets' titles, the menu-bar item. Geist (bundled in PorchKit, registered with `CTFontManagerRegisterFontsForURL`) in content: package titles, meta lines, timeline text, ETA phrases. Geist Mono for tracking numbers and pairing codes. Geist Serif only for the sign-in wordmark and the whole-screen empty state. Every custom font goes through `Font.custom(_:size:relativeTo:)` so Dynamic Type scales it.

| Web role | SwiftUI |
|---|---|
| Row title 15/500 | `.custom("Geist-Medium", size: 15, relativeTo: .body)` |
| Body small 14 | `.custom("Geist-Regular", size: 14, relativeTo: .subheadline)` |
| Label 13/500 | system `.footnote.weight(.medium)` (it is a section header, so chrome) |
| Caption 12 | `.custom("Geist-Regular", size: 12, relativeTo: .caption)` |
| Mono 13 | `.custom("GeistMono-Regular", size: 13, relativeTo: .footnote)` |
| Display 48 | `.custom("GeistSerif-Regular", size: 48, relativeTo: .largeTitle)` |

**Colors.** One asset catalog in PorchKit (`Colors.xcassets`) with Any/Dark appearances, named after the CSS tokens without the dashes: `Canvas`, `Card`, `Elev`, `Ink`, `Body`, `Mute`, `Stone`, `Line`, `Line2`, `Accent`, `Tint`, `Ok`, `Warn`, `Danger`. Values are the hex in §2 (dark into Dark, light into Any). Set `AccentColor` to `Accent` so system controls pick it up. Add "Increase Contrast" variants for `Mute`, `Line` and `Line2`.

- Backgrounds: `Canvas` for screens; on iOS let `List` use `.listStyle(.plain)` with `.scrollContentBackground(.hidden)` over `Canvas`. On macOS keep the system sidebar material in the left pane; the content pane uses `Canvas`.
- Hairlines: `Divider()` tinted with `Line`, or `.listRowSeparatorTint(Color("Line"))`. No shadows.
- Status dot: `Circle().fill(...)` 8pt, or `Circle().strokeBorder(lineWidth: 1.5)` for the hollow states; tones from §4.
- Radii: `RoundedRectangle(cornerRadius: 8, style: .continuous)` for controls, 12 for cards.
- Buttons: system `.borderedProminent` tinted `Accent` for the one primary action, `.bordered` for the rest, `role: .destructive` for Delete. Do not restyle system buttons to imitate the web ones.
- Grouping: the same five groups (§6) as `Section`s with system headers. A date-only ETA (`etaDateOnly`) decodes to `DateComponents` (year, month, day) and is compared with `Calendar.current`'s today as a calendar day; never decode it into a `Date` at midnight UTC.
- Widget and Live Activity: system fonts only at small sizes, Geist for the package title; status dot tones as above.
