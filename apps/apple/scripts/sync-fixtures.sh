#!/usr/bin/env bash
# Copies the shared tracking-number fixtures into PorchKit and records what the
# TypeScript detector returns for each one, so the Swift port can be checked
# against it without running Node during `swift test`.
#
# Run from anywhere after changing packages/carriers/fixtures/numbers.json or
# packages/carriers/src/detect*. Needs Node and the repo's pnpm install
# (for esbuild). Writes:
#   apps/apple/Packages/PorchKit/Tests/Fixtures/numbers.json         (verbatim copy)
#   apps/apple/Packages/PorchKit/Tests/Fixtures/detect-expected.json (TS output)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC="$ROOT/packages/carriers"
OUT="$ROOT/apps/apple/Packages/PorchKit/Tests/Fixtures"
ESBUILD="$ROOT/node_modules/.bin/esbuild"

[ -x "$ESBUILD" ] || { echo "esbuild not found; run pnpm install at $ROOT" >&2; exit 1; }
mkdir -p "$OUT"
cp "$SRC/fixtures/numbers.json" "$OUT/numbers.json"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
"$ESBUILD" "$SRC/src/detect.ts" --bundle --format=esm --platform=node --log-level=warning --outfile="$TMP/detect.mjs"

cat > "$TMP/expected.mjs" <<'JS'
import { readFileSync, writeFileSync } from "node:fs";
const [, , detectPath, fixturesPath, outPath] = process.argv;
const { detectCarrier, normalizeNumber } = await import(detectPath);
const rows = JSON.parse(readFileSync(fixturesPath, "utf8"));

// Inputs beyond the fixtures where a careless port could differ from JS:
// Unicode digits and spaces, U+0085 before the end anchor, case mapping,
// separators, the LaserShip suffix and the length limits.
const probes = [
  "", " ", "1z5r89390357567127", " 1z 999-aa1.0123456784\n", "9400 1112\t0108",
  "1LS7119013618127-1", "1LS7119013618127-2", "1LS7119013618127‐1",
  "1Z5R89390357567127\u0085", "1Z5R89390357567127\u000b", "1Z5R89390357567127﻿",
  "1Z5R8939035756712٧", "١٢٣٤٥٦٧٨٩٠١٢",
  "１Z5R89390357567127", "1Z5R8939 0357567127", "1Z5R8939　0357567127", "1Z5R8939—0357567127",
  "1Z5R8939−0357567127", "1Z5R8939​0357567127", "1Z5R8939_0357567127",
  "TBA000000000000", "tba000000000000", "C11031500001879", "9611020987654312345672",
  "RB123456785US", "RB123456785GB", "RB123456785XX", "986578788855", "996578788855", "3318810025",
  "4201002334249200190132607600833457", "straße", "ǆ", "😀📦", "\u0000",
  "9".repeat(40), "9".repeat(41), "1".repeat(200) + "TBA", "1Z".repeat(5000), "9".repeat(10000),
  " ".repeat(199) + "TBA000000000000",
];

const entry = (input) => ({ input, normalized: normalizeNumber(input), candidates: detectCarrier(input) });
const out = { fixtures: rows.map((r) => entry(r.number)), probes: probes.map(entry) };
writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.fixtures.length} fixtures and ${out.probes.length} probes to ${outPath}`);
JS

node "$TMP/expected.mjs" "$TMP/detect.mjs" "$OUT/numbers.json" "$OUT/detect-expected.json"
