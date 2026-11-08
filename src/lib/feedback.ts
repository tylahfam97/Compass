/** In-app feedback: one plain form POST to the Compass site, which forwards it as a text email
 *  to the maintainer. Form-encoded with no custom headers, so the webview never sends a CORS
 *  preflight. No token or secret lives in the app; the site rate-limits and caps the size. */
export const FEEDBACK_URL = "https://privatecompass.app/api/feedback";
export const MAX_MESSAGE = 4000;
/** The site rejects bodies over 8 KB. Form encoding turns one non-ASCII character into 6-12
 *  bytes, so a long message in another script can pass MAX_MESSAGE and still be too big. */
export const MAX_BODY_BYTES = 8000;
const TIMEOUT_MS = 15_000;

export interface FeedbackInput {
  message: string;
  email?: string;
  version?: string;
  os?: string;
}

/** Exactly what leaves the device: the typed message, the optional reply email, app version, OS. */
export function buildFeedbackBody({ message, email = "", version = "", os = "" }: FeedbackInput) {
  const body = new URLSearchParams({ message: message.trim().slice(0, MAX_MESSAGE) });
  if (email.trim()) body.set("email", email.trim().slice(0, 254));
  body.set("version", version.slice(0, 32));
  body.set("os", os.slice(0, 32));
  return body;
}

/** Resolves on 2xx; throws on any other status, network failure or a 15 s timeout. */
export async function sendFeedback(input: FeedbackInput, fetchImpl: typeof fetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(FEEDBACK_URL, { method: "POST", body: buildFeedbackBody(input), signal: controller.signal });
    if (!res.ok) throw new Error(`Feedback failed: HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
