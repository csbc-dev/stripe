import type { UserContext } from "@csbc-dev/stripe/server";

export interface DemoCart {
  id: string;
  amount: number; // smallest currency unit (yen for jpy, cents for usd)
  currency: string;
}

/**
 * Resolve the authoritative cart for the authenticated user.
 *
 * In a real app this loads the cart/order total from your database keyed by
 * the authenticated `UserContext`. It is the single source of truth for
 * amount + currency — the browser's `amount-value` hint is advisory and
 * tampered-with by definition (CSBC invariant: "the server decides the
 * amount").
 */
export function resolveCart(_ctx: UserContext | undefined): DemoCart {
  return { id: "demo-cart-001", amount: 1980, currency: "jpy" };
}
