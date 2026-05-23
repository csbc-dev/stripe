import { randomUUID } from "node:crypto";
import type {
  IStripeProvider,
  IntentCreationResult,
  PaymentIntentOptions,
  SetupIntentOptions,
  StripeMode,
  StripeIntentView,
  StripeEvent,
} from "@csbc-dev/stripe/server";

/**
 * In-memory `IStripeProvider` so the examples run end-to-end without a Stripe
 * account. It fabricates intent ids / client secrets and always reports a
 * card-brand payment method — paired with the browser-side mock Stripe.js
 * loader, this drives the full `idle → collecting → processing → succeeded`
 * lifecycle deterministically.
 *
 * It implements the SAME `IStripeProvider` seam the real `StripeSdkProvider`
 * does, which is exactly why the Core does not care which one is injected.
 */
export class MockStripeProvider implements IStripeProvider {
  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    const intentId = `pi_mock_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      intentId,
      clientSecret: `${intentId}_secret_${randomUUID().slice(0, 8)}`,
      mode: "payment",
      amount: { value: opts.amount, currency: opts.currency },
    };
  }

  async createSetupIntent(_opts: SetupIntentOptions): Promise<IntentCreationResult> {
    const intentId = `seti_mock_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      intentId,
      clientSecret: `${intentId}_secret_${randomUUID().slice(0, 8)}`,
      mode: "setup",
    };
  }

  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    return {
      id,
      status: "succeeded",
      mode,
      amount: mode === "payment" ? { value: 1980, currency: "jpy" } : undefined,
      paymentMethod: { id: "pm_mock_card", brand: "visa", last4: "4242" },
      // Resume is not exercised in the mock happy-path (no 3DS redirect); this
      // value would only matter for a post-redirect `resumeIntent` compare.
      clientSecret: `${id}_secret_mock`,
    };
  }

  async cancelPaymentIntent(_id: string): Promise<void> {
    /* no-op in mock */
  }

  async cancelSetupIntent(_id: string): Promise<void> {
    /* no-op in mock */
  }

  verifyWebhook(
    rawBody: string | Buffer | Uint8Array,
    _signatureHeader: string,
    _secret: string,
  ): StripeEvent {
    // Mock mode does no HMAC verification — it just parses the JSON body.
    const text = typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");
    const parsed = JSON.parse(text) as Partial<StripeEvent>;
    return {
      id: parsed.id ?? `evt_mock_${randomUUID().slice(0, 8)}`,
      type: parsed.type ?? "mock.event",
      data: parsed.data ?? { object: {} },
      created: parsed.created ?? Math.floor(Date.now() / 1000),
    };
  }
}
