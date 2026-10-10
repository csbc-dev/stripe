import { StripeAmount } from "../types.js";

/**
 * Rebuild a provider-supplied amount into the observable `StripeAmount`
 * view (SPEC §5.1 / §8.2). This is the only gate a provider value passes
 * before `StripeCore._setAmount` and the `requestIntent` return:
 * `IStripeProvider.createPaymentIntent(...).amount` and
 * `IStripeProvider.retrieveIntent(...).amount` (3DS resume, the
 * processing reconcile).
 *
 * The provider seam is open to custom implementations, and the value is
 * wire-visible — the `amount-changed` detail is what RemoteShellProxy
 * forwards as the `update`, `get amount()` is what it reads for `sync`,
 * and the `requestIntent` return crosses as the cmd `return`.
 * @wc-bindable/remote ≥ 0.10 rejects a whole value holding an `undefined`
 * member, a `Date`, `NaN`, … (SPEC §8): the `update` is dropped and the
 * browser keeps its stale amount. Any extra member (an internal order id,
 * a fetch timestamp) would otherwise ride along to the browser too.
 *
 * Rule: `value` must be a finite number and `currency` a non-empty
 * string; only those two fields are copied, in that order. Anything else
 * — a missing or mistyped field, `NaN` / `±Infinity`, a non-object —
 * returns `undefined`, which callers treat exactly like a provider that
 * reported no amount.
 *
 * `StripeSdkProvider`'s `extractAmount` already produces this shape from
 * Stripe's integer `amount` and ISO `currency`, so its values pass
 * through unchanged.
 */
export function toObservableAmount(value: unknown): StripeAmount | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.value !== "number" || !Number.isFinite(v.value)) return undefined;
  if (typeof v.currency !== "string" || v.currency === "") return undefined;
  return { value: v.value, currency: v.currency };
}
