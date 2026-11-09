# Sourced by scripts/testflight.sh and scripts/mac-release.sh. Shared signing steps: 1Password credentials, a temporary
# keychain, and provisioning profiles made through the App Store Connect API. Secrets live only in $TMP (mode 700), which
# the caller deletes on exit together with the keychain; nothing secret is printed or put on a command line.
# Bash 3.2 compatible (macOS /bin/bash).
#
# Settings come from the gitignored scripts/signing.local.sh (see signing.local.sh.example) or the environment:
#   OP_ACCOUNT        1Password account (user id)
#   OP_VAULT          vault of the items below (default Private)
#   ASC_ITEM          item with the App Store Connect API key (field "issuer id", file AuthKey_<ASC_KEY_ID>.p8)
#   ASC_KEY_ID        App Store Connect API key id
#   DIST_CERT_ITEM    Apple Distribution certificate (file AppleDistribution_<team>.p12, "password", "Apple Certificate ID")
#   DEVID_CERT_ITEM   Developer ID Application certificate (file "Developer ID Certificate.p12", "password")

LOCAL=scripts/signing.local.sh
[[ -f "$LOCAL" ]] && source "$LOCAL"
: "${OP_ACCOUNT:?set OP_ACCOUNT (see scripts/signing-lib.sh)}"
: "${ASC_ITEM:?set ASC_ITEM (see scripts/signing-lib.sh)}"
: "${ASC_KEY_ID:?set ASC_KEY_ID (see scripts/signing-lib.sh)}"
OP_VAULT="${OP_VAULT:-Private}"
OP=(op --account "$OP_ACCOUNT")
TEAM_ID=VTQW687WBQ
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/porchlight-sign.XXXXXX")"
KC="$TMP/porchlight-sign.keychain-db"
LOGIN="$HOME/Library/Keychains/login.keychain-db"
source scripts/keychain-list.sh
ORIGINAL_KEYCHAINS="$(keychain_list_save)"   # the person's own search list, put back exactly on exit
signing_cleanup() {
  keychain_list_restore "$ORIGINAL_KEYCHAINS" || true
  security delete-keychain "$KC" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap signing_cleanup EXIT

asc() { ASC_KEY_DIR="$TMP/asc" python3 -I scripts/asc.py "$@"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
die() { echo "error: $*" >&2; exit 1; }
# A 1Password approval prompt that times out returns nothing; stop instead of going on with empty values.
nonempty() { [[ -s "$1" ]] || die "1Password returned nothing for $2. Unlock 1Password, approve the CLI prompt and rerun."; }

# Writes keyid, issuer and the .p8 into $TMP/asc for asc.py, altool and notarytool.
load_asc_key() {
  mkdir -m 700 "$TMP/asc"
  printf %s "$ASC_KEY_ID" > "$TMP/asc/keyid"
  "${OP[@]}" item get "$ASC_ITEM" --fields 'label=issuer id' --reveal | tr -d '[:space:]' > "$TMP/asc/issuer" || true
  nonempty "$TMP/asc/issuer" "the API issuer id"
  "${OP[@]}" read "op://$OP_VAULT/$ASC_ITEM/AuthKey_${ASC_KEY_ID}.p8" --out-file "$TMP/asc/AuthKey_${ASC_KEY_ID}.p8" >/dev/null || true
  nonempty "$TMP/asc/AuthKey_${ASC_KEY_ID}.p8" "the API key file"
}

# import_identity ITEM P12_FILE_NAME IDENTITY_PREFIX: puts the .p12 from 1Password into the temporary keychain and sets
# IDENTITY to the full name of the signing identity that starts with IDENTITY_PREFIX.
import_identity() {
  local item="$1" file="$2" prefix="$3"
  "${OP[@]}" read "op://$OP_VAULT/$item/$file" --out-file "$TMP/cert.p12" >/dev/null || true
  nonempty "$TMP/cert.p12" "the certificate file"
  "${OP[@]}" item get "$item" --fields label=password --reveal | tr -d '\n' > "$TMP/p12pass" || true
  nonempty "$TMP/p12pass" "the certificate password"
  # The temporary keychain has an empty password, so no password is ever on a command line. It is in the 700 folder.
  security create-keychain -p "" "$KC"
  security set-keychain-settings -lut 7200 "$KC"
  security unlock-keychain -p "" "$KC"
  # `security import -P` would put the .p12 password on a command line, so OpenSSL (system LibreSSL, which reads the
  # older .p12 ciphers) opens it with the password from a file and the PEM goes into the keychain.
  /usr/bin/openssl pkcs12 -in "$TMP/cert.p12" -passin "file:$TMP/p12pass" -nodes -out "$TMP/cert.pem" 2>/dev/null \
    || die "could not open the .p12 from 1Password item $item"
  rm -f "$TMP/p12pass" "$TMP/cert.p12"
  security import "$TMP/cert.pem" -k "$KC" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
  rm -f "$TMP/cert.pem"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "" "$KC" >/dev/null
  keychain_list_add "$KC" "$LOGIN"   # login holds Apple's WWDR and Developer ID intermediates
  IDENTITY="$(security find-identity -v -p codesigning "$KC" | sed -nE "s/.*\"($prefix[^\"]+)\".*/\1/p" | head -1)"
  [[ -n "$IDENTITY" ]] || die "no valid '$prefix' identity in 1Password item $item (missing intermediate certificate?)"
}

# make_profile NAME TYPE BUNDLE_ID CERT_ID: replaces the profile called NAME with a fresh one (a profile captures the
# App ID's capabilities when it is made), installs it for Xcode and prints its UUID.
make_profile() {
  local name="$1" type="$2" bundle_id="$3" cert_id="$4" res ref old id body out uuid
  res="$(asc GET "/v1/bundleIds?filter%5Bidentifier%5D=$bundle_id&fields%5BbundleIds%5D=identifier")"
  ref="$(json "next(iter([b['id'] for b in d['data'].get('data', []) if b['attributes']['identifier']=='$bundle_id']), '')" <<< "$res")"
  [[ -n "$ref" ]] || die "the App ID $bundle_id is not registered for team $TEAM_ID (or the API key cannot see it)"
  old="$(asc GET "/v1/profiles?filter%5Bname%5D=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$name")" \
    | json "' '.join(p['id'] for p in d['data'].get('data', []))")"
  for id in $old; do asc DELETE "/v1/profiles/$id" >/dev/null; done
  body="{\"data\":{\"type\":\"profiles\",\"attributes\":{\"name\":\"$name\",\"profileType\":\"$type\"},\"relationships\":{\"bundleId\":{\"data\":{\"type\":\"bundleIds\",\"id\":\"$ref\"}},\"certificates\":{\"data\":[{\"type\":\"certificates\",\"id\":\"$cert_id\"}]}}}}"
  out="$TMP/profile-$bundle_id"
  asc POST /v1/profiles "$body" > "$out.json"
  json "d['status']==201 or sys.exit('error: profile $name not created: ' + json.dumps(d['data'].get('errors')))" < "$out.json" >/dev/null
  json "d['data']['data']['attributes']['profileContent']" < "$out.json" | base64 -D > "$out.provision"
  security cms -D -i "$out.provision" > "$out.plist"
  uuid="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$out.plist")"
  local dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  mkdir -p "$dir"
  cp "$out.provision" "$dir/$uuid.$( [[ "$type" == MAC_* ]] && echo provisionprofile || echo mobileprovision )"
  echo "$uuid"
}
