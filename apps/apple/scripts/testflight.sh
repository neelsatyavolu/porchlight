#!/bin/bash
# Usage: scripts/testflight.sh [--no-upload]
# Builds a signed App Store archive of Porchlight for iOS (app, share extension, widget) and, unless --no-upload, uploads
# it to TestFlight. Credentials come from 1Password at run time (see scripts/signing-lib.sh for the settings).
# BUILD_NUMBER overrides the build number (default: UTC timestamp, always increasing).
# OUT_DIR overrides where the archive, the .ipa and the logs go (default build/testflight).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/signing-lib.sh
: "${DIST_CERT_ITEM:?set DIST_CERT_ITEM (see scripts/signing-lib.sh)}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
OUT_DIR="${OUT_DIR:-build/testflight}"
UPLOAD=1
for arg in "$@"; do
  case "$arg" in
    --no-upload) UPLOAD=0 ;;
    *) echo "usage: scripts/testflight.sh [--no-upload]" >&2; exit 2 ;;
  esac
done

echo "==> Loading credentials from 1Password"
load_asc_key
CERT_ID="$("${OP[@]}" item get "$DIST_CERT_ITEM" --fields 'label=Apple Certificate ID')" || true
[[ -n "$CERT_ID" ]] || die "1Password returned no Apple Certificate ID. Unlock 1Password, approve the CLI prompt and rerun."

echo "==> Importing the distribution certificate into a temporary keychain"
import_identity "$DIST_CERT_ITEM" "AppleDistribution_${TEAM_ID}.p12" "Apple Distribution: "

echo "==> Making fresh App Store provisioning profiles"
APP_PROFILE="$(make_profile "Porchlight App Store" IOS_APP_STORE co.xanom.porchlight "$CERT_ID")"
SHARE_PROFILE="$(make_profile "Porchlight Share App Store" IOS_APP_STORE co.xanom.porchlight.share "$CERT_ID")"
WIDGET_PROFILE="$(make_profile "Porchlight Widget App Store" IOS_APP_STORE co.xanom.porchlight.widget "$CERT_ID")"

echo "==> Archiving build $BUILD_NUMBER"
xcodegen generate >/dev/null
ARCHIVE="$OUT_DIR/Porchlight.xcarchive"
rm -rf "$ARCHIVE" "$OUT_DIR/export"
mkdir -p "$OUT_DIR"
# Profiles go through PORCHLIGHT_*_PROFILE (project.yml): a command-line PROVISIONING_PROFILE_SPECIFIER would also hit
# the package targets and the extensions, which each need their own or none.
nice -n 15 xcodebuild -project Porchlight.xcodeproj -scheme Porchlight-iOS -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" -derivedDataPath "$OUT_DIR/derived" archive -jobs 4 \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY="$IDENTITY" OTHER_CODE_SIGN_FLAGS="--keychain $KC" \
  PORCHLIGHT_APP_PROFILE="$APP_PROFILE" PORCHLIGHT_SHARE_PROFILE="$SHARE_PROFILE" PORCHLIGHT_WIDGET_PROFILE="$WIDGET_PROFILE" \
  > "$OUT_DIR/archive.log" 2>&1 || { grep -E "error:" "$OUT_DIR/archive.log" | sort -u >&2; exit 1; }

echo "==> Exporting the .ipa"
cat > "$TMP/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict>
    <key>co.xanom.porchlight</key><string>$APP_PROFILE</string>
    <key>co.xanom.porchlight.share</key><string>$SHARE_PROFILE</string>
    <key>co.xanom.porchlight.widget</key><string>$WIDGET_PROFILE</string>
  </dict>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$OUT_DIR/export" \
  -exportOptionsPlist "$TMP/export.plist" > "$OUT_DIR/export.log" 2>&1 \
  || { grep -E "error" "$OUT_DIR/export.log" | sort -u >&2; exit 1; }
IPA="$OUT_DIR/export/Porchlight.ipa"
echo "    $IPA"

if [[ "$UPLOAD" == 1 ]]; then
  echo "==> Uploading to App Store Connect"
  API_PRIVATE_KEYS_DIR="$TMP/asc" xcrun altool --upload-app -f "$IPA" -t ios \
    --apiKey "$ASC_KEY_ID" --apiIssuer "$(cat "$TMP/asc/issuer")" --output-format normal
  echo "testflight: uploaded build $BUILD_NUMBER. It shows up in TestFlight once Apple finishes processing it."
else
  echo "testflight: built $IPA (build $BUILD_NUMBER), not uploaded."
fi
