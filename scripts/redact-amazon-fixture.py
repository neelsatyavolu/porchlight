#!/usr/bin/env python3
"""Redact saved Amazon pages into parser fixtures (SPEC §6, "Parser tests").

    python3 -I scripts/redact-amazon-fixture.py OUT_DIR raw1.html [raw2.html ...]

Writes OUT_DIR/<name>.html for each input. All inputs go through one run, so
an order id that appears on the order list and on a track page is remapped to
the same fake id in both.

What it does:
- keeps only the markup the parser reads: tags, `class`, short ids, and the
  hrefs and image srcs it needs, rebuilt from scratch;
- drops scripts, styles, svg, the site header and footer, ads,
  recommendations, maps and popovers (addresses live in those);
- replaces names, street and city lines, emails, phone numbers, order ids,
  shipment ids, ASINs, tracking numbers (prefix kept, digits remapped), prices,
  product titles and facility cities.

The remapping uses a random salt per run, so fake values can't be traced back.
Raw pages hold personal data: keep them out of the repo, and check the output
with a grep for the real values before committing it.
"""
from __future__ import annotations

import hashlib
import html
import os
import re
import secrets
import sys
from html.parser import HTMLParser

SALT = secrets.token_bytes(16)

VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SKIP_TAGS = {"script", "style", "noscript", "svg", "link", "meta", "iframe", "template", "canvas", "video", "header", "footer", "form", "select", "button", "input"}
SKIP_ID = re.compile(r"^(nav|navbar|navFooter|rhf|ape_|ad-|ad_|CardInstance|skiplink|sis_pixel|hmenu|a-popover-(?!tracking-events-modal))", re.I)
SKIP_CLASS = {
    "recsWidgetContainer", "map-banner-card", "rufus-pill", "yo-ask-order-pill", "a-popover-preload", "ad-feedback",
    "yohtmlc-recipient", "pt-shipping-address", "address-info-card", "tpb-delivery-message", "maplibregl-map",
    "mw-popup", "pt-map-fallback", "rufus-text-selection-tooltip",
}
# The tracking-events modal is a popover the parser needs.
KEEP_ID = re.compile(r"^(a-popover-tracking-events-modal|tracking-events-container|ordersInPackage-container|pt-address-info)$")
ALLOWED_HREF = re.compile(r"^(/progress-tracker/package|/gp/your-account/order-history|/your-orders/orders|/your-orders/order-details|/gp/your-account/order-details|/dp/|/gp/product/|/ap/signin)")
KEEP_PARAMS = ("orderId", "shipmentId", "packageIndex", "orderID", "startIndex")

ORDER_ID = re.compile(r"\b\d{3}-\d{7}-\d{7}\b")
TRACKING = re.compile(r"\b(TB[ACM]\d{12}|1Z[0-9A-Z]{16}|9[0-9]{19,21}|[A-Z]{2}\d{9}US|\d{12}|\d{15}|\d{20}|\d{22})\b")
ASIN = re.compile(r"\bB0[0-9A-Z]{8}\b")
EMAIL = re.compile(r"[\w.+-]+@[\w-]+(\.[\w-]+)+")
PHONE = re.compile(r"(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b")
PRICE = re.compile(r"\$\s?\d[\d,]*(\.\d{2})?")
ZIP = re.compile(r"\b\d{5}(-\d{4})?\b")
CARD = re.compile(r"\b(ending in|ending with)\s*\d{4}\b", re.I)

FAKE_PRODUCTS = [
    "USB-C charging cable, 6 ft, 2-pack", "Stainless steel water bottle, 24 oz", "Paperback notebook, dotted, A5",
    "LED desk lamp with dimmer", "AA batteries, 8-pack", "Wireless mouse, gray", "Kitchen sponges, 6-pack",
    "Phone stand, aluminum", "Hand soap refill, 34 oz", "Cotton crew socks, 6 pairs", "HDMI cable, 10 ft",
    "Granola bars, variety pack, 24 count", "Laundry detergent pods, 42 count", "Sticky notes, 12 pads",
]
# Words Amazon prints next to the owner's name that are not part of it.
NOT_NAMES = {"amazon", "prime", "account", "lists", "sign", "hello", "deliver", "update", "location", "locker", "united", "states"}
FAKE_CITIES = ["Springfield", "Riverton", "Fairview", "Lakewood", "Greenville", "Madison"]


def digest(value: str) -> bytes:
    return hashlib.sha256(SALT + value.encode()).digest()


def remap_chars(value: str, keep_prefix: int = 0) -> str:
    """Same shape: digits stay digits, letters stay letters, separators stay."""
    d = digest(value)
    out = []
    for i, ch in enumerate(value):
        b = d[i % len(d)] ^ (i * 31 & 0xFF)
        if i < keep_prefix or not ch.isalnum():
            out.append(ch)
        elif ch.isdigit():
            out.append(str(b % 10))
        elif ch.isupper():
            out.append(chr(ord("A") + b % 26))
        else:
            out.append(chr(ord("a") + b % 26))
    return "".join(out)


def remap_tracking(m: re.Match[str]) -> str:
    v = m.group(0)
    prefix = 3 if v.startswith("TB") else 2 if v.startswith("1Z") else 0
    return remap_chars(v, keep_prefix=prefix)


class Collector(HTMLParser):
    """First pass: the owner's names and address lines, wherever Amazon prints them."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.capture = 0
        self.names: set[str] = set()
        self.address_lines: set[str] = set()
        self.titles: set[str] = set()
        self.cities: set[str] = set()
        self._ctx: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: v or "" for k, v in attrs}
        cls, ident = set(a.get("class", "").split()), a.get("id", "")
        ctx = ""
        if cls & {"pt-shipping-address", "displayAddressDiv"} or ident.startswith("a-popover-shippingAddress"):
            ctx = "address"
        elif "insert-encrypted-trigger-text" in cls or ident in ("glow-ingress-line1", "nav-link-accountList-nav-line-1"):
            ctx = "name"
        elif cls & {"yohtmlc-product-title", "yo-enhanced-title"}:
            ctx = "title"
        elif "tracking-event-location" in cls:
            ctx = "city"
        if tag not in VOID:
            self._ctx.append(ctx or (self._ctx[-1] if self._ctx else ""))

    def handle_endtag(self, tag: str) -> None:
        if tag not in VOID and self._ctx:
            self._ctx.pop()

    def handle_data(self, data: str) -> None:
        text = " ".join(data.split())
        if not text or not self._ctx:
            return
        ctx = self._ctx[-1]
        if ctx == "address":
            self.address_lines.add(text)
        elif ctx == "name":
            text = re.sub(r"^(Deliver to|Hello,|Ship to)\s*", "", text).strip()
            if text.lower() in ("sign in", "account & lists"):
                return
            if text and text not in ("Ship to", "Deliver to") and not text.isdigit():
                self.names.add(text)
        elif ctx == "title" and len(text) > 3:
            self.titles.add(text)
        elif ctx == "city":
            city = text.split(",")[0].strip()
            if city and city.upper() != "US":
                self.cities.add(city)


class Redactor(HTMLParser):
    def __init__(self, scrub) -> None:
        super().__init__(convert_charrefs=True)
        self.scrub = scrub
        self.out: list[str] = []
        self.stack: list[str] = []
        self.skip_at: int | None = None
        self.in_head = False

    def _skip(self, tag: str, a: dict[str, str]) -> bool:
        if tag in SKIP_TAGS:
            return True
        ident, cls = a.get("id", ""), a.get("class", "")
        if KEEP_ID.match(ident):
            return False
        return bool(SKIP_ID.match(ident) or SKIP_CLASS.intersection(cls.split()) or cls.startswith("maplibregl"))

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k: (v or "") for k, v in attrs}
        if self.skip_at is not None:
            if tag not in VOID:
                self.stack.append(tag)
            return
        if tag == "head":
            self.in_head = True
        if self._skip(tag, a):
            if tag not in VOID:
                self.stack.append(tag)
                self.skip_at = len(self.stack)
            return
        if self.in_head and tag not in ("head", "title"):
            if tag not in VOID:
                self.stack.append(tag)
                self.skip_at = len(self.stack)
            return
        self.out.append(self._tag(tag, a))
        if tag not in VOID:
            self.stack.append(tag)

    def _tag(self, tag: str, a: dict[str, str]) -> str:
        keep: list[tuple[str, str]] = []
        if a.get("id") and not re.search(r"[0-9a-f]{12,}|\d{4,}", a["id"]):
            keep.append(("id", a["id"]))
        if a.get("class"):
            keep.append(("class", " ".join(a["class"].split())))
        if tag == "a" and a.get("href"):
            href = self._href(a["href"])
            if href:
                keep.append(("href", href))
        if tag == "img" and a.get("src"):
            src = a["src"]
            if src.startswith("https://m.media-amazon.com/images/"):
                keep.append(("src", "https://m.media-amazon.com/images/I/" + remap_chars(src)[-11:].replace("/", "x") + ".jpg"))
        label = a.get("aria-label", "")
        if label and ("status" in label.lower() or label.endswith(("Complete", "Incomplete"))):
            keep.append(("aria-label", label))
        attrs = "".join(f' {k}="{html.escape(v, quote=True)}"' for k, v in keep)
        return f"<{tag}{attrs}>"

    def _href(self, href: str) -> str | None:
        href = html.unescape(href)
        href = re.sub(r"^https://www\.amazon\.com", "", href)
        if href.startswith("#"):
            return "#"
        path, _, query = href.partition("?")
        if not ALLOWED_HREF.match(path):
            return None
        path = ASIN.sub(lambda m: remap_chars(m.group(0), 2), path)
        path = re.sub(r"/ref=[^/?]*", "", path)
        params = []
        for part in query.split("&"):
            k, _, v = part.partition("=")
            if k in KEEP_PARAMS:
                v = ORDER_ID.sub(lambda m: remap_chars(m.group(0)), v)
                if k == "shipmentId":
                    v = remap_chars(v)
                params.append(f"{k}={v}")
        return path + ("?" + "&".join(params) if params else "")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in VOID or tag not in self.stack:
            return
        while self.stack:
            open_tag = self.stack.pop()
            depth = len(self.stack) + 1
            if self.skip_at is not None:
                if depth == self.skip_at:
                    self.skip_at = None
            else:
                self.out.append(f"</{open_tag}>")
            if open_tag == "head":
                self.in_head = False
            if open_tag == tag:
                break

    def handle_data(self, data: str) -> None:
        if self.skip_at is not None:
            return
        text = " ".join(data.split())
        if text:
            self.out.append(html.escape(self.scrub(text), quote=False))


def build_scrubber(c: Collector):
    pairs: list[tuple[str, str]] = []
    for i, title in enumerate(sorted(c.titles)):
        pairs.append((title, FAKE_PRODUCTS[int.from_bytes(digest(title)[:2], "big") % len(FAKE_PRODUCTS)]))
    for line in sorted(c.address_lines, key=len, reverse=True):
        pairs.append((line, "Sample address line"))
    words: set[str] = set()
    for name in c.names:
        words.update(w for w in re.split(r"[\s,]+", name) if len(w) >= 3)
    for line in c.address_lines:
        words.update(w for w in re.split(r"[\s,]+", line) if len(w) >= 4 and w.isalpha() and w.upper() not in ("UNITED", "STATES", "AMAZON"))
    words = {w for w in words if w.lower() not in NOT_NAMES}
    for i, city in enumerate(sorted(c.cities)):
        pairs.append((city, FAKE_CITIES[i % len(FAKE_CITIES)]))
    word_re = re.compile(r"\b(" + "|".join(re.escape(w) for w in sorted(words, key=len, reverse=True)) + r")\b", re.I) if words else None

    def scrub(text: str) -> str:
        for real, fake in pairs:
            if real in text:
                text = text.replace(real, fake)
        if word_re:
            text = word_re.sub("Alex", text)
        text = EMAIL.sub("alex@example.com", text)
        text = CARD.sub(lambda m: m.group(1) + " 0000", text)
        text = ORDER_ID.sub(lambda m: remap_chars(m.group(0)), text)
        text = TRACKING.sub(remap_tracking, text)
        text = ASIN.sub(lambda m: remap_chars(m.group(0), 2), text)
        text = PHONE.sub("555-0100", text)
        text = PRICE.sub(lambda m: "$" + remap_chars(m.group(0)[1:]), text)
        text = ZIP.sub("00000", text)
        return text

    return scrub


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    out_dir, inputs = argv[1], argv[2:]
    raw = {path: open(path, encoding="utf-8").read() for path in inputs}
    collector = Collector()
    for text in raw.values():
        collector.feed(text)
    scrub = build_scrubber(collector)
    os.makedirs(out_dir, exist_ok=True)
    for path, text in raw.items():
        r = Redactor(scrub)
        r.feed(text)
        r.close()
        body = "".join(r.out)
        body = re.sub(r"(<(div|span|li|ul|section|p|h\d)( [^>]*)?></\2>)+", "", body)  # drop empty leaves left by skipped subtrees
        name = os.path.basename(path)
        with open(os.path.join(out_dir, name), "w", encoding="utf-8") as f:
            f.write("<!doctype html>\n<!-- Redacted with scripts/redact-amazon-fixture.py -->\n" + body.replace("><", ">\n<") + "\n")
        print(f"{name}: {len(text)} -> {len(body)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
