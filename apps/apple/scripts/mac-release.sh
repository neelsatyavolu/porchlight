#!/bin/bash
# Usage: scripts/mac-release.sh
# Builds Porchlight for macOS signed with Developer ID (hardened runtime), notarizes and staples the app, then wraps it in
# a DMG (app + /Applications link) that is signed, notarized and stapled too. Output: build/release/Porchlight-<version>.dmg.
# Credentials come from 1Password at run time (see scripts/signing-lib.sh for the settings).
# BUILD_NUMBER overrides the build number (default: UTC timestamp).
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/signing-lib.sh
: "${DEVID_CERT_ITEM:?set DEVID_CERT_ITEM (see scripts/signing-lib.sh)}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
OUT_DIR=build/release
WORK="$OUT_DIR/work"
BUNDLE_ID=co.xanom.porchlight

echo "==> Loading credentials from 1Password"
load_asc_key
NOTARY=(--key "$TMP/asc/AuthKey_${ASC_KEY_ID}.p8" --key-id "$ASC_KEY_ID" --issuer "$(cat "$TMP/asc/issuer")")

echo "==> Importing the Developer ID certificate into a temporary keychain"
import_identity "$DEVID_CERT_ITEM" "Developer ID Certificate.p12" "Developer ID Application: "
# The profile must name the same certificate as the identity: match on the serial number.
SERIAL="$(security find-certificate -c "$IDENTITY" -p "$KC" | /usr/bin/openssl x509 -noout -serial | cut -d= -f2)"
CERT_ID="$(asc GET "/v1/certificates?filter%5BcertificateType%5D=DEVELOPER_ID_APPLICATION_G2,DEVELOPER_ID_APPLICATION&limit=200" \
  | json "next(iter([c['id'] for c in d['data'].get('data', []) if c['attributes'].get('serialNumber','').upper()=='$SERIAL'.upper()]), '')")"
[[ -n "$CERT_ID" ]] || die "App Store Connect has no Developer ID certificate with serial $SERIAL"

echo "==> Making a fresh Developer ID provisioning profile"
# Push, Sign in with Apple and the keychain access group are restricted entitlements, which need a profile.
APP_PROFILE="$(make_profile "Porchlight Developer ID" MAC_APP_DIRECT "$BUNDLE_ID" "$CERT_ID")"

echo "==> Archiving build $BUILD_NUMBER"
xcodegen generate >/dev/null
ARCHIVE="$WORK/Porchlight.xcarchive"
rm -rf "$WORK"
mkdir -p "$WORK"
nice -n 15 xcodebuild -project Porchlight.xcodeproj -scheme Porchlight-macOS -configuration Release \
  -destination 'generic/platform=macOS' -archivePath "$ARCHIVE" -derivedDataPath "$WORK/derived" archive -jobs 4 \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY="$IDENTITY" OTHER_CODE_SIGN_FLAGS="--keychain $KC --timestamp" ENABLE_HARDENED_RUNTIME=YES \
  PORCHLIGHT_APP_PROFILE="$APP_PROFILE" \
  > "$WORK/archive.log" 2>&1 || { grep -E "error:" "$WORK/archive.log" | sort -u >&2; exit 1; }

echo "==> Exporting with Developer ID"
cat > "$TMP/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
  <key>provisioningProfiles</key><dict><key>$BUNDLE_ID</key><string>$APP_PROFILE</string></dict>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportPath "$WORK/export" \
  -exportOptionsPlist "$TMP/export.plist" > "$WORK/export.log" 2>&1 \
  || { grep -E "error" "$WORK/export.log" | sort -u >&2; exit 1; }
APP="$WORK/export/Porchlight.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
codesign --verify --deep --strict "$APP"

# notarize FILE: submits FILE, waits, prints Apple's log on failure, then staples the ticket to STAPLE_TARGET.
notarize() {
  local file="$1" target="$2" result id
  result="$(xcrun notarytool submit "$file" "${NOTARY[@]}" --wait --output-format json)" || true
  [[ "$result" == \{* ]] || die "notarytool gave no result for $(basename "$file"): $result"
  id="$(json "d.get('id','')" <<< "$result")"
  if [[ "$(json "d.get('status','')" <<< "$result")" != Accepted ]]; then
    echo "$result" >&2
    [[ -n "$id" ]] && xcrun notarytool log "$id" "${NOTARY[@]}" >&2
    die "notarization of $(basename "$file") was not accepted"
  fi
  xcrun stapler staple "$target" >/dev/null
  echo "    notarized $(basename "$target") (submission $id)"
}

echo "==> Notarizing the app"
ditto -c -k --keepParent "$APP" "$WORK/Porchlight.zip"
notarize "$WORK/Porchlight.zip" "$APP"

echo "==> Building the DMG"
DMG="$OUT_DIR/Porchlight-$VERSION.dmg"
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Porchlight.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Porchlight" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null
chmod 644 "$DMG"   # the umask 077 for secrets would otherwise leave the download unreadable to others
codesign --sign "$IDENTITY" --keychain "$KC" --timestamp "$DMG"

echo "==> Notarizing the DMG"
notarize "$DMG" "$DMG"
xcrun stapler validate "$DMG" >/dev/null
spctl -a -t open --context context:primary-signature "$DMG"
rm -rf "$WORK/dmg" "$WORK/Porchlight.zip"
echo "mac-release: $DMG (version $VERSION, build $BUILD_NUMBER)"
