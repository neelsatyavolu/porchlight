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
const OWNED_DIRS = ["styles", "fonts", "icons", "download", "updates"];

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

  const files = await readdir(src);
  const pages = files.filter((f) => f.endsWith(".html"));
  for (const page of pages) await copyFile(path.join(src, page), path.join(out, page));
  // site.css (every page); home.css and sections.css (the home page only).
  for (const sheet of files.filter((f) => f.endsWith(".css"))) {
    await copyFile(path.join(src, sheet), path.join(out, "styles", sheet));
  }
  await copyFile(tokens, path.join(out, "styles/tokens.css"));
  await writeFile(path.join(out, "styles/fonts.css"), `${fontFaces()}\n`);
  await writeFile(path.join(out, "_headers"), await headersFile());
  for (const [, from, to] of FONTS) {
    await copyFile(path.join(geistRoot, "dist/fonts", from), path.join(out, "fonts", to));
  }
  // Favicons made by apps/apple/scripts/make-icons.sh from apps/apple/Design/AppIcon.svg.
  await mkdir(path.join(out, "icons"), { recursive: true });
  for (const icon of await readdir(path.join(src, "icons"))) {
    await copyFile(path.join(src, "icons", icon), path.join(out, "icons", icon));
  }
  await copyMacDownload();
  console.info(`site: ${pages.length} pages -> ${path.relative(process.cwd(), out)}`);
}

// The notarized DMG and Sparkle feed from apps/apple/scripts/mac-release.sh. The DMG is
// served under its own name (the feed's enclosure URL) and as /download/Porchlight.dmg
// (the landing page's link); the feed is /updates/appcast.xml, which installed Mac apps poll.
// A deploy without them, or with a feed that names another DMG, fails.
async function copyMacDownload() {
  const release = path.resolve(here, "../apps/apple/build/release");
  const hint = "run apps/apple/scripts/mac-release.sh";
  const dmgs = (await readdir(release).catch(() => [])).filter((f) => /^Porchlight-.+\.dmg$/.test(f));
  if (dmgs.length !== 1) throw new Error(`expected one Porchlight-<version>-<build>.dmg in ${release}, found ${dmgs.length}; ${hint}`);
  const [dmg] = dmgs;
  const appcast = await readFile(path.join(release, "appcast.xml"), "utf8").catch(() => {
    throw new Error(`no appcast.xml in ${release}; ${hint}`);
  });
  if (!appcast.includes(`/download/${dmg}"`)) throw new Error(`appcast.xml doesn't point at ${dmg}; ${hint}`);
  await mkdir(path.join(out, "download"), { recursive: true });
  await mkdir(path.join(out, "updates"), { recursive: true });
  await copyFile(path.join(release, dmg), path.join(out, "download", dmg));
  await copyFile(path.join(release, dmg), path.join(out, "download/Porchlight.dmg"));
  await writeFile(path.join(out, "updates/appcast.xml"), appcast);
  console.info(`site: ${dmg} -> download/, appcast -> updates/appcast.xml`);
}

build().catch((err) => {
  console.error("site build failed:", err);
  process.exit(1);
});
