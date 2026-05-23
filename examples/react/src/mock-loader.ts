import type {
  StripeJsLoader,
  StripeJsLike,
  StripePaymentElementLike,
} from "@csbc-dev/stripe";

/**
 * A fake Stripe.js, injected via `WcsStripe.setLoader()` in mock mode. It
 * renders a placeholder where the Payment Element would mount and resolves
 * `confirmPayment` / `confirmSetup` to a successful, card-brand result — so the
 * whole `idle → collecting → processing → succeeded` lifecycle runs with no
 * Stripe account and no real card.
 *
 * It satisfies the same `StripeJsLike` structural contract the real Stripe.js
 * does, which is the seam that makes this swap possible.
 */
export function createMockStripeLoader(): StripeJsLoader {
  return async (_publishableKey: string): Promise<StripeJsLike> => ({
    elements() {
      let paymentElement: StripePaymentElementLike | null = null;
      return {
        create() {
          const handlers: Record<string, (ev: Record<string, unknown>) => void> = {};
          paymentElement = {
            mount(target) {
              const host =
                typeof target === "string"
                  ? (document.querySelector(target) as HTMLElement | null)
                  : target;
              if (host) {
                host.innerHTML =
                  '<div class="mock-pe">🧪 Mock Stripe Elements' +
                  "<br /><small>No real card needed — click Pay to simulate a successful charge.</small></div>";
              }
              // Mimic Stripe.js firing ready + a "complete" change on next tick.
              setTimeout(() => {
                handlers.ready?.({});
                handlers.change?.({ complete: true });
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
