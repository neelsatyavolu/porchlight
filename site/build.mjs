// Builds the marketing pages into services/api/public (README.md, "Serving").
// Plain copy, no bundler: HTML from src/, tokens.css from apps/web, Geist
// woff2 files from the geist package. Leaves public/app (the web app) alone.
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "../services/api/public");
const src = path.join(here, "src");
const tokens = path.resolve(here, "../apps/web/src/styles/tokens.css");
// The Worker adds these to the responses it serves (services/api/src/lib/assets.ts);
// public/_headers gives the same ones to files Cloudflare serves without the Worker.
const securityHeaders = path.resolve(here, "../services/api/src/lib/security-headers.json");
// geist's "exports" hide its font files, so read them from the installed folder.
const geistRoot = path.join(here, "node_modules/geist");

const FONTS = [
  ["Geist", "geist-sans/Geist-Variable.woff2", "Geist.woff2"],
  ["Geist Mono", "geist-mono/GeistMono-Variable.woff2", "GeistMono.woff2"],
  ["Geist Serif", "geist-serif/GeistSerifVF.woff2", "GeistSerif.woff2"],
];

/** Everything this script owns in public/. */
const OWNED_DIRS = ["styles", "fonts"];

async function clean() {
  await mkdir(out, { recursive: true });
  for (const entry of await readdir(out, { withFileTypes: true })) {
    const owned = entry.isFile() ? entry.name.endsWith(".html") || entry.name === "_headers" : OWNED_DIRS.includes(entry.name);
    if (owned) await rm(path.join(out, entry.name), { recursive: true });
  }
}

function fontFaces() {
  return FONTS.map(
    ([family, , file]) =>
      `@font-face{font-family:"${family}";src:url("/fonts/${file}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}`,
  ).join("\n");
}

async function headersFile() {
  const headers = JSON.parse(await readFile(securityHeaders, "utf8"));
  const lines = Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`);
  return `/*\n${lines.join("\n")}\n`;
}

async function build() {
  await clean();
  await mkdir(path.join(out, "styles"), { recursive: true });
  await mkdir(path.join(out, "fonts"), { recursive: true });

  const pages = (await readdir(src)).filter((f) => f.endsWith(".html"));
  for (const page of pages) await copyFile(path.join(src, page), path.join(out, page));
  await copyFile(path.join(src, "site.css"), path.join(out, "styles/site.css"));
  await copyFile(tokens, path.join(out, "styles/tokens.css"));
  await writeFile(path.join(out, "styles/fonts.css"), `${fontFaces()}\n`);
  await writeFile(path.join(out, "_headers"), await headersFile());
  for (const [, from, to] of FONTS) {
    await copyFile(path.join(geistRoot, "dist/fonts", from), path.join(out, "fonts", to));
  }
  console.info(`site: ${pages.length} pages -> ${path.relative(process.cwd(), out)}`);
}

build().catch((err) => {
  console.error("site build failed:", err);
  process.exit(1);
});
