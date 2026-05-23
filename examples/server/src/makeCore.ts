import { StripeCore, StripeSdkProvider } from "@csbc-dev/stripe/server";
import type {
  IStripeProvider,
  IntentBuilder,
  StripeNodeLike,
  UserContext,
} from "@csbc-dev/stripe/server";
import { MockStripeProvider } from "./mockProvider.js";
import { resolveCart } from "./cart.js";

export interface ProviderFactory {
  /** true when STRIPE_SECRET_KEY was set and the real SDK provider is in use. */
  live: boolean;
  webhookSecret: string | undefined;
  /** Build a fresh provider per WS connection (per-session idempotency namespace). */
  makeProvider(sessionId: string): IStripeProvider;
}

/**
 * Decide between the real `StripeSdkProvider` and the `MockStripeProvider`
 * based on `process.env.STRIPE_SECRET_KEY`. The Stripe client (which holds the
 * secret key) is created once; a fresh `StripeSdkProvider` is built per
 * connection so each browser session gets its own idempotency-key namespace.
 *
 * Idempotency-key shape (important — this is the educational bit):
 * an idempotency key must be STABLE for retries of the *same logical request*
 * but DISTINCT across separate checkout attempts. The Core calls
 * `createPaymentIntent` / `createSetupIntent` exactly once per `requestIntent`,
 * so a per-session monotonic counter (bumped once per provider create call)
 * gives each attempt — Pay → Reset → Pay, or payment ↔ setup ↔ payment within
 * one WS session — its own key, while the SDK provider still reuses that same
 * key if it has to retry the in-flight create after a network flake. Keying
 * only on `${operation}:${sessionId}` would be constant within a session, so a
 * second Pay would reuse the first key and live Stripe would REPLAY the first
 * intent instead of creating a new one. (The MockStripeProvider ignores the
 * key entirely, so this only matters on the live path.)
 */
export async function createProviderFactory(): Promise<ProviderFactory> {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || undefined;

  if (secret) {
    // `stripe` is an optional dependency — only imported on the real path.
    // It IS installed in this example's tree, but a fresh checkout that skipped
    // optional installs must still typecheck. Mirrors the dynamic
    // `@stripe/stripe-js` import guard in src/components/Stripe.ts. The
    // @ts-ignore must sit immediately above the import to actually apply to it.
    // @ts-ignore — the `stripe` optionalDependency may be absent (--no-optional).
    const Stripe = (await import("stripe")).default;
    const client = new Stripe(secret) as unknown as StripeNodeLike;
    return {
      live: true,
      webhookSecret,
      makeProvider: (sessionId) => {
        // One counter per provider (i.e. per WS session). Each provider
        // create call advances it, so every checkout attempt in the session
        // gets a distinct key while a retry of the *current* create reuses it.
        let attempt = 0;
        return new StripeSdkProvider(client, {
          buildIdempotencyKey: ({ operation }) => `${operation}:${sessionId}:${attempt++}`,
        });
      },
    };
  }

  // Mock mode: the MockStripeProvider does NO HMAC verification — its
  // verifyWebhook just parses the JSON body. So a STRIPE_WEBHOOK_SECRET set
  // here would be misleading: it would make `factory.webhookSecret` truthy and
  // route /webhooks/stripe into MockStripeProvider.verifyWebhook, i.e. accept
  // ANY unsigned payload as "verified". To avoid that "I set a secret but
  // nothing is verified" footgun, force webhookSecret to undefined in mock
  // mode (so index.ts's `if (!factory.webhookSecret)` short-circuits to the
  // explicit "skipped" response) and warn if one was supplied.
  if (webhookSecret) {
    console.warn(
      "[stripe-core] STRIPE_WEBHOOK_SECRET is set but STRIPE_SECRET_KEY is not — running in MOCK mode. " +
        "The mock provider does not verify signatures, so the secret is ignored and webhooks are skipped. " +
        "Set STRIPE_SECRET_KEY to enable real signature verification.",
    );
  }

  return {
    live: false,
    webhookSecret: undefined,
    makeProvider: () => new MockStripeProvider(),
  };
}

/**
 * The single point that turns a (tamperable) client hint + authenticated user
 * context into the authoritative intent options. Amount/currency come from the
 * server-resolved cart, NEVER from `request.hint`.
 */
const intentBuilder: IntentBuilder = (request, ctx) => {
  if (request.mode === "setup") {
    // Save a card for later off-session charges; no amount involved.
    return { mode: "setup", usage: "off_session" };
  }
  const cart = resolveCart(ctx);
  return {
    mode: "payment",
    amount: cart.amount,
    currency: cart.currency,
    metadata: {
      cartId: cart.id,
      sessionId: typeof ctx?.sessionId === "string" ? ctx.sessionId : "",
    },
  };
};

/**
 * Build a per-connection Core. Each WS connection is one authenticated session
 * (recommended CSBC shape for multi-tenant WS servers): its own `userContext`,
 * its own provider, disposed when the socket closes.
 */
export function createCore(factory: ProviderFactory, sessionId: string): StripeCore {
  const userContext: UserContext = { sub: "demo-user", sessionId };

  const core = new StripeCore(factory.makeProvider(sessionId), {
    webhookSecret: factory.webhookSecret,
    userContext,
    // Also cancel SetupIntents on abort/cancel so the dashboard stays clean.
    cancelSetupIntents: true,
  });

  core.registerIntentBuilder(intentBuilder);

  core.registerWebhookHandler("payment_intent.succeeded", (event) => {
    const obj = event.data.object as { id?: string };
    console.log(`[webhook] payment_intent.succeeded ${obj.id ?? ""}`);
    // Real app: fulfill the order here, idempotently keyed by event.id.
  });

  return core;
}
