import { StripePaymentMethod } from "../types.js";

/**
 * Per-field length cap for the validated `StripePaymentMethod` view.
 *
 * `id`: Stripe pm_* identifiers are < 30 chars in practice; 128 leaves
 * comfortable headroom for any future extension.
 * `brand`: known brand tokens (`visa`, `mastercard`, `amex`, `diners`,
 * `discover`, `jcb`, `unionpay`, `cartes_bancaires`, …) are all under 32
 * chars; 64 keeps the bound clearly above any extension Stripe might add.
 * `last4`: Stripe always uses 4 digits, but we accept up to 8 to be lax
 * about future tokenized formats (BIN-only displays, IBAN tail digits)
 * without dropping the upper bound entirely.
 *
 * The cap exists because `_setPaymentMethod` is also reachable from a
 * tamperable wire path (`reportConfirmation` over RemoteShellProxy);
 * without bounds, a `last4: "A".repeat(10_000)` payload could flood
 * logs / UI sinks the same way an unbounded `error.message` would.
 */
const _PM_FIELD_MAX_LENGTH = { id: 128, brand: 64, last4: 8 } as const;

/**
 * Validate that an externally-supplied `StripePaymentMethod`-shaped value
 * actually matches the published shape — three non-empty strings, no
 * extra fields the rest of the codebase will treat as authoritative.
 *
 * Wire surface: `reportConfirmation({ paymentMethod })` arrives verbatim
 * from a tamperable Shell (the browser, optionally over RemoteShellProxy
 * + WebSocket). Without this gate, a forged report could put arbitrary
 * shape onto the Core's `_paymentMethod` slot — observable through the
 * `paymentMethod-changed` CustomEvent detail, the bindable surface, and
 * any UI that renders `el.paymentMethod`. Card-data leakage is
 * structurally prevented by Stripe Elements (raw card never leaves the
 * iframe), but a malformed report could still ship attacker-controlled
 * strings for `id` / `brand` / `last4`.
 *
 * Returns the narrowed value on pass, `undefined` on fail. The caller
 * (`StripeCore._setPaymentMethod`) treats `undefined` the same as a
 * report that omitted `paymentMethod` — fall back to the server-side
 * retrieve / webhook fold path, which is sourced from Stripe directly
 * and trustworthy.
 */
export function validateReportedPaymentMethod(value: unknown): StripePaymentMethod | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const id = typeof v.id === "string" ? v.id : "";
  const brand = typeof v.brand === "string" ? v.brand : "";
  const last4 = typeof v.last4 === "string" ? v.last4 : "";
  if (!id || !brand || !last4) return undefined;
  if (id.length > _PM_FIELD_MAX_LENGTH.id) return undefined;
  if (brand.length > _PM_FIELD_MAX_LENGTH.brand) return undefined;
  if (last4.length > _PM_FIELD_MAX_LENGTH.last4) return undefined;
  // Drop any extra keys: only the three documented fields propagate.
  // Otherwise a `__proto__` / `toJSON` / extension key on the wire would
  // pollute the surface even though TypeScript narrowed to
  // `StripePaymentMethod` two layers up.
  return { id, brand, last4 };
}

/**
 * Extract a minimal card-PaymentMethod view from a Stripe object (typically
 * a PaymentIntent / SetupIntent retrieve result, a webhook payload, or a
 * Stripe.js confirm result).
 *
 * Returns a value only when `payment_method` is expanded into an object
 * AND that object carries a `card`. Non-card (e.g. bank_transfer, pix) and
 * non-expanded (bare pm_... string) shapes return undefined so the caller
 * can decide whether to try another channel — server-side retrieve,
 * webhook fallback, etc.
 *
 * Shared between the Core, the SdkProvider, and the Shell so a shape
 * change in Stripe's response (new brand tokens, expanded last4 moving,
 * etc.) only requires an update here. Lives under `internal/` because it
 * is an implementation helper, not part of the package's public surface.
 *
 * Field length caps mirror `validateReportedPaymentMethod` even though
 * this path is server-trusted (Stripe.js / webhook / retrieve) — a Stripe-
 * side anomaly or a browser-extension that rewrites the Stripe.js confirm
 * result before it reaches us could still inject pathological strings,
 * so symmetry with the wire-validated path keeps log/UI sinks bounded.
 */
export function extractCardPaymentMethod(obj: Record<string, unknown>): StripePaymentMethod | undefined {
  const pm = obj.payment_method;
  if (pm && typeof pm === "object") {
    const pmObj = pm as Record<string, unknown>;
    const card = pmObj.card;
    if (card && typeof card === "object") {
      const c = card as Record<string, unknown>;
      const id = typeof pmObj.id === "string" && pmObj.id ? pmObj.id : undefined;
      const brand = typeof c.brand === "string" && c.brand ? c.brand : undefined;
      const last4 = typeof c.last4 === "string" && c.last4 ? c.last4 : undefined;
      // Require all three. SPEC §5.1 types `brand` / `last4` as non-empty
      // strings for a reason: UIs render `"Visa •• 4242"` and an empty
      // brand or last4 produces a nonsensical `"•• "` display. Better to
      // fall back to the webhook / retrieve channel that CAN populate
      // them than to emit a half-populated shape that lies to the UI.
      if (!id || !brand || !last4) return undefined;
      // Length caps shared with `validateReportedPaymentMethod` — drop the
      // shape rather than truncate so a downstream subscriber never sees
      // a half-rendered "Visa •• 424242…" display.
      if (id.length > _PM_FIELD_MAX_LENGTH.id) return undefined;
      if (brand.length > _PM_FIELD_MAX_LENGTH.brand) return undefined;
      if (last4.length > _PM_FIELD_MAX_LENGTH.last4) return undefined;
      return { id, brand, last4 };
    }
  }
  return undefined;
}
