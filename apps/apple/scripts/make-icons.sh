#!/bin/bash
# Renders the app icon from apps/apple/Design/AppIcon.svg into:
#   - the iOS 1024 icon (opaque, full bleed) and the macOS sizes (rounded square
#     with Apple's standard margin) in the app's AppIcon.appiconset
#   - favicons for the site and web app (site/src/icons)
# Needs Google Chrome (headless render) and ImageMagick (`magick`).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
svg="$here/Design/AppIcon.svg"
set_dir="$(ls -d "$here"/Porchlight/Resources/*.xcassets/AppIcon.appiconset)"
site_icons="$repo/site/src/icons"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

render() { # svg-file out-png
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
    --window-size=1024,1024 --screenshot="$2" "file://$1" >/dev/null 2>&1
}

# iOS: full bleed, no alpha (App Store rejects transparency).
render "$svg" "$tmp/ios.png"
magick "$tmp/ios.png" -background "#050507" -alpha remove -alpha off "$set_dir/icon-ios-1024.png"

# macOS: the artwork inside an 824 pt rounded square (radius 185) centred on a
# transparent 1024 canvas, per Apple's macOS icon grid.
body="$(sed -e '1d' -e '$d' "$svg")"
cat > "$tmp/mac.svg" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs><clipPath id="r"><rect x="100" y="100" width="824" height="824" rx="185"/></clipPath></defs>
  <g clip-path="url(#r)"><g transform="translate(100 100) scale(0.8046875)">
$body
  </g></g>
</svg>
EOF
render "$tmp/mac.svg" "$tmp/mac.png"
for size in 16 32 128 256 512; do
  magick "$tmp/mac.png" -resize "${size}x${size}" "$set_dir/icon-mac-${size}@1x.png"
  magick "$tmp/mac.png" -resize "$((size * 2))x$((size * 2))" "$set_dir/icon-mac-${size}@2x.png"
done

# Favicons: SVG for modern browsers, PNGs for Apple touch and fallback.
mkdir -p "$site_icons"
cp "$svg" "$site_icons/icon.svg"
magick "$tmp/ios.png" -background "#050507" -alpha remove -alpha off -resize 180x180 "$site_icons/apple-touch-icon.png"
magick "$tmp/mac.png" -resize 32x32 "$site_icons/favicon-32.png"
echo "icons written to $set_dir and $site_icons"
