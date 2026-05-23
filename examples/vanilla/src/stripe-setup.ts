import { bootstrapStripe, WcsStripe } from "@csbc-dev/stripe";
import { createMockStripeLoader } from "./mock-loader";

/**
 * One-time browser setup. Importing this module (side effect) registers the
 * <stripe-checkout> custom element and enables remote mode, so it MUST run
 * before the element upgrades. main.ts imports it first.
 */
const REMOTE_URL = import.meta.env.VITE_REMOTE_CORE_URL ?? "ws://localhost:8787/stripe";

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
