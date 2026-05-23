import { bootstrapStripe, WcsStripe } from "@csbc-dev/stripe";
import { createMockStripeLoader } from "./mock-loader";

/**
 * One-time browser setup. MUST run before any <stripe-checkout> connects, so
 * import this module at the top of the entry file (main.tsx).
 *
 *  1. In mock mode, replace Stripe.js with the fake loader.
 *  2. Enable remote mode + register the <stripe-checkout> custom element.
 */
const REMOTE_URL = import.meta.env.VITE_REMOTE_CORE_URL ?? "ws://localhost:8787/stripe";

/** A real pk_test_... if provided, otherwise a mock key (must start with "pk_"). */
export const PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? "pk_test_mock_000";
export const IS_MOCK = !import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;

if (IS_MOCK) {
  WcsStripe.setLoader(createMockStripeLoader());
}

bootstrapStripe({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: REMOTE_URL,
  },
});
