/**
 * Stripe error taxonomy regex / constants shared between Core and Shell.
 *
 * Why a shared module: both `StripeCore._sanitizeError` (server-side)
 * and `Stripe._setErrorStateFromUnknown` / `_safeType` (browser-side)
 * gate Stripe-shaped tokens against the same allowlist. Inlined copies
 * in two files drifted in the past — a tightening on Core (e.g. dropping
 * `/i`) silently left the Shell on the older shape, which would let a
 * forged `"Card_Error"` token through the Shell's purely-local error
 * paths (`_sanitizeStripeJsError`, key-change cmd-throw, transport-only
 * rejection) even after the Core wire-side closed the same gate.
 *
 * No `node:crypto` / DOM dependency lives here, so this module is safe
 * for the browser graph and the server graph alike.
 */

/**
 * Stripe API object tokens (`card_error`, `invalid_request_error`, …) are
 * always lowercase snake. No `/i` flag — forged capitalized variants like
 * `"Card_Error"` must not forward downstream as if they were real tokens.
 */
export const STRIPE_TAXONOMY_TOKEN_RE: RegExp = /^[a-z0-9_]{1,64}$/;

/**
 * Stripe error code regex. 96 allows hierarchical dotted variants
 * (e.g. `"payment_intent.authentication_required"`). Lowercase only —
 * Stripe's error-code space does not use uppercase.
 */
export const STRIPE_ERROR_CODE_RE: RegExp = /^[a-z0-9_.]{1,96}$/;

/**
 * Stripe SDK error class names: `StripeCardError`, `StripeAPIError`,
 * `StripeConnectionError`, `StripeInvalidRequestError`,
 * `StripeIdempotencyError`, etc. Tight shape requirement (PascalCase
 * body + `Error` suffix) so a stray `StripeLeak` on a forged error
 * cannot pass the `startsWith("Stripe")` check.
 */
export const STRIPE_CLASS_NAME_RE: RegExp = /^Stripe[A-Z][A-Za-z]*Error$/;

/**
 * Known-safe Stripe error type tokens. `message` is only forwarded when
 * `type` matches one of these (or the "Stripe<ClassName>" SDK shape) — a
 * lax `*_error` suffix match would let an app throw
 * `Object.assign(new Error("db creds at 10.0.0.5"), { type: "app_config_error" })`
 * and leak the internal message across the wire (SPEC §9.3).
 */
export const STRIPE_KNOWN_TYPES: ReadonlySet<string> = new Set([
  "card_error",
  "validation_error",
  "invalid_request_error",
  "api_error",
  "idempotency_error",
  "rate_limit_error",
  "authentication_error",
  "api_connection_error",
]);

/**
 * Upper bound on the sanitized `message` length that crosses the wire /
 * reaches the DOM. A pathological server-side throw (`new Error(bigString)`)
 * would otherwise flood logs, the WebSocket frame, and UI renderers.
 * 512 is comfortably above Stripe's own user-facing error messages
 * (observed < 200 chars) and a multi-sentence hand-written diagnostic
 * from this package's own internal errors.
 */
export const MAX_ERROR_MESSAGE_LENGTH: number = 512;

/**
 * Bounded, shape-preserving summary of an arbitrary wire-untrusted value
 * for inclusion in `raiseError` / log diagnostic messages.
 *
 * Used at every Core input-validation site (`requestIntent`,
 * `resumeIntent`, `reportConfirmation`, …) that needs to mention the
 * offending value in its rejection. A naive `JSON.stringify(value)` on a
 * megabyte-sized tampered payload would otherwise produce a
 * megabyte-sized error message that floods the WebSocket frame echoing
 * the throw and any log sink. `set mode` already uses this exact shape
 * for the same reason; extracting it here keeps every command's
 * diagnostic under the same DoS-resistant bound.
 *
 * Output bounds:
 *   - `typeof` `"object"`  → `"null"` / `"[object]"` (no JSON expansion).
 *   - `typeof` `"string"`  → quoted, truncated to 32 chars + ellipsis.
 *   - everything else      → `String(value)` (typeof "number" / "boolean"
 *                            / "undefined" / "function" / "symbol" /
 *                            "bigint" all produce short literal strings).
 *
 * The output is purely diagnostic — never used in security decisions.
 */
export function summarizeUntrustedValue(value: unknown): string {
  if (typeof value === "object") {
    return value === null ? "null" : "[object]";
  }
  if (typeof value === "string") {
    // Two-stage cap. The first slice trims the raw char count to a
    // reasonable preview window; the second cap is applied AFTER
    // `JSON.stringify` because escaping can multiply the output size
    // by ~6× — every emoji / supplementary-plane code point
    // serializes as a 12-character `"\uHHHH\uHHHH"` surrogate-pair
    // escape, and a 32-char emoji string can balloon to almost 200
    // characters of JSON. The post-stringify cap (64) keeps the
    // rendered diagnostic bounded regardless of the input's escape
    // expansion. Truncated output ends with the same `..."` shape
    // as the pre-stringify path so the abbreviation is visible.
    const POST_JSON_CAP = 64;
    const clipped = value.length > 32 ? value.slice(0, 32) + "..." : value;
    const json = JSON.stringify(clipped);
    if (json.length <= POST_JSON_CAP) return json;
    // Reserve 4 chars for `..."` terminator so the final string is a
    // syntactically-recognizable truncated quoted-string.
    return json.slice(0, POST_JSON_CAP - 4) + '..."';
  }
  return String(value);
}
