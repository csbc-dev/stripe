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
