"""Minimal App Store Connect API client used by testflight.sh and mac-release.sh.

Usage: python3 -I scripts/asc.py METHOD PATH [JSON_BODY]
Reads keyid, issuer and AuthKey_<keyid>.p8 from the folder in $ASC_KEY_DIR. Prints {"status", "data"} as JSON;
never prints the key or the token.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

KEY_DIR = Path(os.environ["ASC_KEY_DIR"])
KEY_ID = (KEY_DIR / "keyid").read_text().strip()
ISSUER = (KEY_DIR / "issuer").read_text().strip()
KEY = serialization.load_pem_private_key((KEY_DIR / f"AuthKey_{KEY_ID}.p8").read_bytes(), password=None)


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def token() -> str:
    """ES256 JWT valid for 15 minutes, as App Store Connect requires."""
    header = b64(json.dumps({"alg": "ES256", "kid": KEY_ID, "typ": "JWT"}).encode())
    now = int(time.time())
    payload = b64(json.dumps({"iss": ISSUER, "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}).encode())
    r, s = decode_dss_signature(KEY.sign(f"{header}.{payload}".encode(), ec.ECDSA(hashes.SHA256())))  # type: ignore[call-arg]
    return f"{header}.{payload}.{b64(r.to_bytes(32, 'big') + s.to_bytes(32, 'big'))}"


def call(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(
        "https://api.appstoreconnect.apple.com" + path,
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {token()}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw) if raw else {}


if __name__ == "__main__":
    status, data = call(sys.argv[1], sys.argv[2], json.loads(sys.argv[3]) if len(sys.argv) > 3 else None)
    print(json.dumps({"status": status, "data": data}))
