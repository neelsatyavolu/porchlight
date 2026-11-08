// Magic-link email through Resend's HTTP API. `fetch` is injectable so tests
// never send mail.
export const RESEND_URL = "https://api.resend.com/emails";

export interface MagicLinkMail {
  apiKey: string;
  to: string;
  /** e.g. "https://porchlight.xanom.co"; the sender domain and link host. */
  appOrigin: string;
  link: string;
  code: string;
  /** EMAIL_FROM, e.g. "Porchlight <signin@n3el.dev>" when the app host isn't a Resend-verified domain. */
  from?: string;
}

let fetchImpl: typeof fetch = (input, init) => fetch(input, init);

/** Test hook: replaces the fetch used to call Resend. */
export function setResendFetch(impl: typeof fetch): void {
  fetchImpl = impl;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Throws when Resend does not accept the message. */
export async function sendMagicLink(mail: MagicLinkMail): Promise<void> {
  const host = new URL(mail.appOrigin).host;
  const text = [
    "Sign in to Porchlight with this link (it works once and expires in 15 minutes):",
    "",
    mail.link,
    "",
    `Or type this code: ${mail.code}`,
    "",
    "If you didn't ask to sign in, ignore this email.",
  ].join("\n");
  const html =
    `<p>Sign in to Porchlight with this link. It works once and expires in 15 minutes.</p>` +
    `<p><a href="${escapeHtml(mail.link)}">Sign in to Porchlight</a></p>` +
    `<p>Or type this code: <strong>${escapeHtml(mail.code)}</strong></p>` +
    `<p>If you didn't ask to sign in, ignore this email.</p>`;

  const res = await fetchImpl(RESEND_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${mail.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: mail.from ?? `Porchlight <signin@${host}>`,
      to: [mail.to],
      subject: `Your Porchlight sign-in code: ${mail.code}`,
      text,
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend returned ${res.status}`);
}
