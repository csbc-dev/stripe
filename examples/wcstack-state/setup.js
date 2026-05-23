// Browser-side setup, loaded as a plain module (no bundler). Resolves
// `@csbc-dev/stripe` via the <importmap> in index.html.
import { bootstrapStripe, WcsStripe } from "@csbc-dev/stripe";

// --- Mock Stripe.js loader (no Stripe account needed) ---
function createMockStripeLoader() {
  return async () => ({
    elements() {
      let paymentElement = null;
      return {
        create() {
          const handlers = {};
          paymentElement = {
            mount(target) {
              const host = typeof target === "string" ? document.querySelector(target) : target;
              if (host) {
                host.innerHTML =
                  '<div class="mock-pe">🧪 Mock Stripe Elements' +
                  "<br><small>No real card needed — click Pay to simulate a successful charge.</small></div>";
              }
              setTimeout(() => {
                handlers.ready && handlers.ready({});
                handlers.change && handlers.change({ complete: true });
              }, 0);
            },
            unmount() {},
            destroy() {},
            on(event, cb) {
              handlers[event] = cb;
            },
          };
          return paymentElement;
        },
        getElement() {
          return paymentElement;
        },
      };
    },
    async confirmPayment() {
      return {
        paymentIntent: {
          id: "pi_mock",
          status: "succeeded",
          payment_method: { id: "pm_mock_card", card: { brand: "visa", last4: "4242" } },
        },
      };
    },
    async confirmSetup() {
      return {
        setupIntent: {
          id: "seti_mock",
          status: "succeeded",
          payment_method: { id: "pm_mock_card", card: { brand: "visa", last4: "4242" } },
        },
      };
    },
  });
}

// To use REAL Stripe: set this to your pk_test_... and start the server with
// STRIPE_SECRET_KEY set (see ../server/.env.example).
const PUBLISHABLE_KEY = "pk_test_mock_000";
const IS_MOCK = PUBLISHABLE_KEY === "pk_test_mock_000";

if (IS_MOCK) {
  WcsStripe.setLoader(createMockStripeLoader());
}

// Enable remote mode + register <stripe-checkout>.
bootstrapStripe({
  remote: {
    enableRemote: true,
    remoteSettingType: "config",
    remoteCoreUrl: "ws://localhost:8787/stripe",
  },
});

// Keep the header badge honest: the static "mock" label in index.html is just
// a default — reflect the real mode here so swapping in a live pk_test_ key
// flips it to "live test" (matches the react/vue/vanilla examples).
const modeTag = document.querySelector(".mode-tag");
if (modeTag) modeTag.textContent = IS_MOCK ? "mock" : "live test";

// publishable-key / return-url are not wcBindable inputs — set them as
// attributes. Setting publishable-key last triggers auto-prepare.
const el = document.querySelector("stripe-checkout");
if (el) {
  el.setAttribute("return-url", location.origin + location.pathname);
  el.setAttribute("publishable-key", PUBLISHABLE_KEY);
}
