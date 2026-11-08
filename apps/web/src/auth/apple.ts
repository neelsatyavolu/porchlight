// Sign in with Apple on the web, through Apple's JS SDK in popup mode.
// The server checks that the identity token's `nonce` claim is the SHA-256 hex
// of the raw nonce we post (services/api/src/lib/apple.ts), so Apple gets the
// hash and /v1/auth/apple gets the raw value.

export const APPLE_SDK_URL = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";

export interface AppleConfig {
  /** The Apple services id; it must also be listed in the server's APPLE_CLIENT_IDS. */
  clientId: string;
  /** Must be registered with the services id, even in popup mode. */
  redirectUri: string;
}

interface AppleSignInResponse {
  authorization: { id_token: string; code: string; state?: string };
}

interface AppleIdSdk {
  auth: {
    init(config: {
      clientId: string;
      scope: string;
      redirectURI: string;
      nonce: string;
      state?: string;
      usePopup: boolean;
    }): void;
    signIn(): Promise<AppleSignInResponse>;
  };
}

declare global {
  interface Window {
    AppleID?: AppleIdSdk;
  }
}

/** Reads VITE_APPLE_CLIENT_ID (and optional VITE_APPLE_REDIRECT_URI). Null hides the button. */
export function appleConfig(env: Record<string, unknown> = import.meta.env): AppleConfig | null {
  const clientId = typeof env.VITE_APPLE_CLIENT_ID === "string" ? env.VITE_APPLE_CLIENT_ID.trim() : "";
  if (!clientId) return null;
  const redirect = typeof env.VITE_APPLE_REDIRECT_URI === "string" ? env.VITE_APPLE_REDIRECT_URI.trim() : "";
  return { clientId, redirectUri: redirect || `${window.location.origin}/signin` };
}

/** The user closed the popup or cancelled; not an error worth showing. */
export class AppleCancelled extends Error {
  constructor() {
    super("Sign in with Apple was cancelled");
    this.name = "AppleCancelled";
  }
}

let sdkPromise: Promise<AppleIdSdk> | null = null;

export function loadAppleSdk(): Promise<AppleIdSdk> {
  if (window.AppleID) return Promise.resolve(window.AppleID);
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<AppleIdSdk>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = APPLE_SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.AppleID) resolve(window.AppleID);
      else reject(new Error("Apple's sign-in script loaded but did not start"));
    };
    script.onerror = () => {
      sdkPromise = null;
      script.remove();
      reject(new Error("Couldn't load Sign in with Apple. Check your connection and try again."));
    };
    document.head.appendChild(script);
  });
  return sdkPromise;
}

export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function isCancel(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { error?: unknown }).error;
  return code === "popup_closed_by_user" || code === "user_cancelled_authorize";
}

/** Opens Apple's popup and returns what POST /v1/auth/apple needs. */
export async function signInWithApple(
  config: AppleConfig,
  load: () => Promise<AppleIdSdk> = loadAppleSdk,
): Promise<{ identityToken: string; nonce: string }> {
  const sdk = await load();
  const nonce = randomNonce();
  sdk.auth.init({
    clientId: config.clientId,
    scope: "email",
    redirectURI: config.redirectUri,
    nonce: await sha256Hex(nonce),
    usePopup: true,
  });
  let res: AppleSignInResponse;
  try {
    res = await sdk.auth.signIn();
  } catch (err) {
    if (isCancel(err)) throw new AppleCancelled();
    throw new Error("Sign in with Apple didn't finish. Try again.");
  }
  const identityToken = res?.authorization?.id_token;
  if (!identityToken) throw new Error("Apple didn't send an identity token. Try again.");
  return { identityToken, nonce };
}
