# @csbc-dev/stripe

`@csbc-dev/stripe` is a headless **Stripe payments** component built on wc-bindable-protocol.

It is not a visual UI widget.
It is an **I/O node** that connects Stripe's PaymentIntent / SetupIntent + Elements flow to reactive state — with PCI-safe card entry, 3DS redirect handling, and server-side webhook reconciliation.

- **input / command surface**: `mode`, `amount-value`, `amount-currency`, `customer-id`, `publishable-key`, `return-url`, `prepare()`, `submit()`, `reset()`, `abort()`
- **output state surface**: `status`, `loading`, `amount`, `paymentMethod`, `intentId`, `error`

`@csbc-dev/stripe` follows the **CSBC (Core/Shell Bindable Component)** architecture:

- **Core** (`StripeCore`) lives server-side. Owns the Stripe secret key (via `IStripeProvider`), creates PaymentIntents / SetupIntents, verifies and dispatches webhook events.
- **Shell** (`<stripe-checkout>`) lives in the browser. Loads Stripe.js, mounts the Payment Element in an iframe **sandboxed by Stripe**, drives `confirmPayment` / `confirmSetup`, handles the 3DS redirect return.
- **Card data never traverses the WebSocket** — Stripe Elements posts it directly to Stripe from within its iframe; only PaymentIntent creation, confirmation outcomes, and webhook-driven status updates flow through our server.

In the CSBC taxonomy this is the **Case C** shape: the Core owns decisions and policy on the server, while the Shell is a browser-anchored execution engine for a data plane the server cannot perform on the browser's behalf.

See [SPEC.md](./SPEC.md) for the full protocol — state machine, wcBindable surface, authorization model for 3DS resume, PCI scope invariants, webhook pipeline, and the security section that apps must follow in production.

## Quick start

### Server

Server-side code **must** import from the `/server` subpath. The bare package name `@csbc-dev/stripe` is the browser barrel — it re-exports `<stripe-checkout>` (a Custom Element built on `HTMLElement`). The component guards its `HTMLElement` base with a `typeof` fallback so the barrel *evaluates* under plain Node without crashing (useful for SSR pre-render, test pre-scanners, and bundler graph walks that touch the root specifier), but the component is **not functional on the server** — there is no `customElements` registry, no DOM, no Stripe.js. `StripeCore` / `StripeSdkProvider` are exported **only** from `/server` so Node-side code reaches the headless pieces through the entry intended for it, not through the browser surface.

> ⚠️ **Lifecycle note**: this Quick Start shows the Core wired up **at request / connection time** — `authenticatedUser` and `activeCartId` are per-request values resolved by your auth middleware. Do NOT build a single module-level `StripeCore` at server startup and try to close over request-scoped variables — that pattern captures `undefined` at module-eval time and, worse, shares one `userContext` across every tenant. Two production-safe shapes:
>
> 1. **Per-connection Core (recommended for multi-tenant WebSocket servers)**: build `provider` + `core` inside the WS `upgrade` handler once per authenticated session, and `core.dispose()` on `close`. Each session gets its own `userContext` / `buildIdempotencyKey` closure.
> 2. **One Core per process + per-request metadata**: keep `core` / `provider` at module scope and pass request-scoped data through the `IntentBuilder`'s return value — set `metadata: { userId, cartId }` on the intent options, then read it in `buildIdempotencyKey` via `ctx.options.metadata`:
>
>    ```ts
>    // IntentBuilder — embed the request-scoped keys into Stripe metadata
>    core.registerIntentBuilder((request, ctx) => ({
>      mode: "payment",
>      amount,
>      currency,
>      metadata: { userId: ctx.sub, cartId: cart.id },
>    }));
>
>    // buildIdempotencyKey — read back the same fields
>    new StripeSdkProvider(stripe, {
>      buildIdempotencyKey: ({ operation, options }) => {
>        const meta = options.metadata as { userId?: string; cartId?: string } | undefined;
>        return `${operation}:${meta?.userId ?? "anon"}:${meta?.cartId ?? "none"}`;
>      },
>    });
>    ```
>
> The example below assumes shape 1 — `authenticatedUser` / `activeCartId` are in scope because the block is conceptually inside a per-connection handler.

```ts
import Stripe from "stripe";
import { StripeCore, StripeSdkProvider } from "@csbc-dev/stripe/server";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const provider = new StripeSdkProvider(stripe, {
  // Optional but recommended: make intent creation idempotent per cart/user.
  // `authenticatedUser` / `activeCartId` are per-request values — see the
  // lifecycle note above for multi-tenant patterns.
  buildIdempotencyKey: ({ operation }) => `${operation}:${authenticatedUser.sub}:${activeCartId}`,
});

const core = new StripeCore(provider, {
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  userContext: authenticatedUser,
  // Optional: also cancel SetupIntents on abort/cancelIntent.
  // Default is false (state-only reset for SetupIntents).
  cancelSetupIntents: true,
});

// REQUIRED — server decides the final amount/currency/metadata from the
// authenticated user + cart, never from the Shell's hint.
core.registerIntentBuilder((request, ctx) => {
  if (request.mode === "setup") {
    return { mode: "setup", customer: resolveCustomer(ctx) };
  }
  const cart = loadCart(ctx);
  return {
    mode: "payment",
    amount: cart.totalInSmallestCurrencyUnit(),
    currency: cart.currency,
    metadata: { cartId: cart.id },
  };
});

// Webhook route handler — Stripe's HMAC-signed events land here.
core.registerWebhookHandler("payment_intent.succeeded", async (event) => {
  await fulfillOrder(event.data.object);
});

// Wire to an HTTP endpoint. `rawBody` MUST be the unparsed request body.
// Stripe treats every response other than 2xx (and a timeout) as a failed
// delivery and retries it: for up to three days with exponential backoff
// in live mode, three times over a few hours in a sandbox. A 4xx does NOT
// stop the retries; only a 2xx does (https://docs.stripe.com/webhooks#automatic-retries).
// The status code is a diagnostic shown in the endpoint's Event deliveries
// tab, not a way to choose whether Stripe retries (SPEC §6.2):
//   200 — handled, or a duplicate the Core's dedup window suppressed. A
//     duplicate that arrives while the first delivery of the same event is
//     still running waits for it and gets the same outcome (200 or 500).
//   400 — not a valid Stripe delivery: no `stripe-signature` header, or
//     StripeSignatureVerificationError. A forged request is not Stripe's,
//     so nothing retries it. A genuine delivery that fails here means the
//     signing secret or the raw body is wrong; Stripe keeps retrying it,
//     and it goes through once that is fixed.
//   500 — everything else is a failure on our side: a fatal handler threw
//     (DB write failed, downstream 5xx), or a `[@csbc-dev/stripe]` error
//     (raw body missing, no webhookSecret on the Core, a custom provider's
//     verifyWebhook returning a malformed event, a disposed Core, including
//     one disposed while the delivery was being processed). Stripe
//     retries, so the event is processed once the cause is fixed.
// Never answer 2xx for a failure you still need handled: that acknowledges
// the event and ends the retries. Stripe disables an endpoint that keeps
// failing for several days, so log and alert on the 500s. A response that
// takes too long also counts as failed, and this route answers only after
// every handler has run, by design (see "Why the webhook route answers
// after the handlers run" below), so keep handlers quick.
// StripeCore keeps a best-effort in-memory dedup window keyed by
// `event.id` and may suppress duplicate deliveries on the same process.
// Durable idempotency still belongs in your handler storage layer.
app.post("/webhooks/stripe", async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string" || signature === "") {
    res.status(400).end();
    return;
  }
  try {
    await core.handleWebhook(req.rawBody, signature);
    res.status(200).end();
  } catch (err) {
    // Log `err` server-side; never echo its message in the response.
    const isSignatureError =
      (err as { type?: unknown } | null)?.type === "StripeSignatureVerificationError";
    res.status(isSignatureError ? 400 : 500).end();
  }
});
```

#### Why the webhook route answers after the handlers run

Stripe recommends returning a 2xx quickly, before any complex logic that could time out, and processing events from an asynchronous queue ([Quickly return a 2xx response](https://docs.stripe.com/webhooks#acknowledge-events-immediately), [Handle events asynchronously](https://docs.stripe.com/webhooks#handle-events-asynchronously)). `handleWebhook` deliberately does not. It settles only after signature verification, the event shape check, dedup, the state fold and every registered handler (fatal and non-fatal, awaited one at a time) have run, and the route above answers with that outcome. The fold of a `succeeded` event may also make one `retrieveIntent` call to Stripe before the handlers run.

- **Why.** A failed fatal handler becomes a 500, so Stripe's own retries (up to three days in live mode) carry the failure. A 2xx sent first would acknowledge the event before anyone knew whether it was handled. Your app therefore needs no queue, dead-letter store or reprocessing job of its own for webhook failures. The dedup window completes this: a fatal throw evicts the event id, so the retry runs again, while a handled id stays, so a retry reaching the same process afterwards ends in 200 without rerunning anything. Your handler's own `event.id` idempotency covers other processes and restarts. Together they make every event converge at least once, as long as the cause is fixed within Stripe's retry period.
- **Duplicates that arrive mid-processing.** A delivery of the same event can reach the same process while the first one is still running (Stripe retrying after a timeout, a resend from the dashboard). It still goes through signature verification and the shape check, then waits for the first delivery and settles the same way, without running the fold or any handler: it resolves (200) if the first one does, and rejects with the same error (500) if a fatal handler threw, so Stripe retries both and the next delivery is processed from scratch. If the Core is disposed before the first delivery's outcome is decided, the duplicate rejects at once with the disposed error, and the first delivery rejects with the same error once its current handler returns (next point), so both get a 500. Events whose `id` bypasses dedup are not held back and still run in parallel. Do not await `handleWebhook` for an event from inside its own handler: that call would wait for the handler itself.
- **Disposing a Core mid-processing.** If `dispose()` runs while a delivery's fold or a handler is being awaited (or inside a `webhook-warning` listener), the delivery runs no further handler and rejects with the disposed error (`[@csbc-dev/stripe] StripeCore has been disposed.`) once that returns, whatever the awaited handler did; a fatal handler's own throw is replaced by the disposed error too, but kept as its `cause` (non-enumerable, like `new Error(message, { cause })`; a non-fatal handler's failure as well), so the route's log still shows it. Webhook errors never cross the remote wire. The route answers 500, so Stripe retries and the event is processed by another Core or process instead of being acknowledged with its remaining handlers skipped. The id does not stay in the dedup window (`dispose()` clears it). The outcome is decided when the Core resumes after the last handler and finds itself not disposed: a dispose before that rejects even if the last handler has already finished (your handler's `event.id` idempotency absorbs the retry), and a dispose after that changes neither the delivery's outcome nor its waiting duplicates'. To avoid these 500s when you retire a Core that receives webhooks, stop routing deliveries to it and let in-flight `handleWebhook` calls finish before calling `dispose()`.
- **Cost.** The response time is the processing time. A slow handler makes Stripe time the delivery out and retry it, even if the handler eventually succeeds. A retry that reaches the process while the first delivery is still running waits for it too, so it can time out as well; once the first delivery finishes, the next retry ends at once with 200 if it succeeded, or is processed again if it failed. Stripe disables an endpoint that stays unresponsive or keeps returning errors for several days ([Stripe support](https://support.stripe.com/questions/why-is-stripe-trying-to-reach-my-webhook-endpoints)), which stops every event type it receives.
- **Recommendation.** Keep handlers fast. Make the fatal handler only record the work somewhere durable, for example by inserting the event into your job queue or a table keyed uniquely by `event.id`, and throw if that fails. Then run fulfillment, emails and downstream API calls from your queue worker. Non-fatal handlers are awaited before the response too, so keep them fast as well. Measure the route's latency and alert on timeouts and 500s.
- **If you need to answer 2xx first.** Respond 200 once the `stripe-signature` header is present, then call `core.handleWebhook(rawBody, signature)` in the same request without awaiting it, and log its rejection. Stripe then never retries a failure (a handler, signature or shape failure has already been acknowledged), so detecting and reprocessing failed events becomes your app's job, and the Event deliveries tab no longer shows whether processing succeeded. Call `handleWebhook` right away rather than queueing the raw body: stripe-node rejects a signature whose timestamp is older than its tolerance (five minutes by default, [Preventing replay attacks](https://docs.stripe.com/webhooks#replay-attacks)).

See SPEC.md §6.2 for the full rationale.

### Browser

```html
<stripe-checkout
  mode="payment"
  publishable-key="pk_live_..."
  amount-value="1980"
  amount-currency="jpy"
  return-url="https://example.com/checkout/complete"
></stripe-checkout>

<button onclick="document.querySelector('stripe-checkout').submit()">Pay</button>
```

Auto-prepare mounts Stripe Elements as soon as the element is connected and a `publishable-key` is present. `submit()` drives confirmation. 3DS redirect returns are detected and folded back into state via an authenticated `resumeIntent` call (the element reads Stripe's `payment_intent_client_secret` from the URL as the ownership token).

If that resume fails, what happens to the redirect params depends only on whether the Core's answer carries a Stripe error `code`. With a code (`resume_client_secret_mismatch`, `resume_not_authorized`, a Stripe reject such as `resource_missing`) the failure is decisive: the params are stripped so a reload does not resume again. Without one (the server could not reach Stripe, a custom provider's `retrieveIntent` resolved with something that is not an object, the WebSocket dropped, the command never reached the Core) it is transient: the params stay in the URL, auto-prepare stays blocked, and the next connect / re-mount / reload retries the resume — the charge may already have gone through at Stripe. Local and remote mode classify the same failure the same way; in remote mode an `error` the Core held before the resume was sent (for example one delivered by the initial sync) never counts as its answer. See SPEC.md §4.

The same rule decides how any failed call to the Core shows up in remote mode — the intent request behind `prepare()`, the 3DS resume, and an attribute value sent to the Core. Each failure produces one `stripe-checkout:error`. If the Core published an `error` for the call after it was sent, that error (with `declineCode` / `type`) is the report; otherwise the element reports the rejection itself. An error the Core already held when the call went out, such as an earlier decline or one delivered by the initial sync, is never shown in place of the new failure. A WebSocket drop is reported once, as `transport_unavailable`; the calls it cuts off still reject, but add no second `stripe-checkout:error`. Best-effort calls (the confirmation report, orphan-intent cleanup, the cancel in `abort()`, `reset`) are not reported on `el.error`; they go to `Stripe.setLogger`. See SPEC.md §8.

## Security — Your Responsibilities

The Quick Start is **deliberately minimal** and **not production-ready**. Before shipping, read SPEC.md §9 and at a minimum:

- **Authenticate the WebSocket / HTTP session** that backs the Core.
- **Compute the intent amount server-side** in `registerIntentBuilder` from authenticated user context. Never trust `request.hint.amountValue`.
- **Preserve the raw webhook body** before any JSON parser touches it — signature verification requires the exact bytes Stripe sent.
- **Enable idempotent intent creation** by supplying `buildIdempotencyKey` to `StripeSdkProvider` (or implement it in your own `IStripeProvider`). On network flake, retries without a key can create multiple intents for the same cart/user.
- **Prefer `await el.abort()` before removing the element** when you need deterministic cancel of the active PaymentIntent. Automatic disconnect teardown is best-effort; in a narrow window (disconnect during in-flight intent create), the intent may survive until Stripe natural expiry.
- **Understand SetupIntent cancel defaults**: by default `cancelIntent` does not call Stripe's `setupIntents.cancel` (state-only reset). If dashboard cleanup of stale SetupIntents matters, set `cancelSetupIntents: true` on `StripeCore` and use a provider that implements `cancelSetupIntent`.
- **Keep webhook handlers idempotent** even with Core dedup enabled. Core suppresses duplicate `event.id` deliveries only within an in-memory per-process window; multi-process routing and process restarts still require DB-backed idempotency keyed by `event.id`. Only a non-blank string `event.id` enters that window: an event from a custom provider whose `id` is empty, whitespace-only, missing or not a string (a number, an object) is never deduped and runs the handlers on every delivery.
- **Consider `registerResumeAuthorizer`** for multi-tenant deployments so a leaked `client_secret` alone cannot resume a foreign user's intent.
- **Handle WebSocket disconnects in your app** (remote mode only). The `<stripe-checkout>` element connects once per mount and does NOT auto-reconnect on `close` / `error` events (mobile network drop, server rolling deploy, LB idle timeout). Subscribe to `stripe-checkout:error` and, on `code: "transport_unavailable"`, remove + re-append the element — or prompt the user to retry. See SPEC §9.3 for the rationale (auto-reconnect would push backoff policy, in-flight promise handling, and infinite-retry safety onto the library).
- **Sanitize errors** that cross the wire: the built-in sanitizer keeps `code` / `decline_code` / `type` and forwards `message` only for Stripe-shaped errors (type starts with `Stripe` or matches a known Stripe taxonomy token like `card_error` / `invalid_request_error`) and our own `[@csbc-dev/stripe]`-prefixed internals — anything else collapses to a generic `"Payment failed."` so a raw `new Error("FATAL: ...")` from an `IntentBuilder` does not reach the browser. **Do not fake Stripe type tokens on your own errors** (`Object.assign(err, { type: "card_error" })`) — that bypasses the allowlist. Custom handlers you add (webhook fulfillment, authorizers) must be equally careful. See SPEC §6.3.1.
- **Keep `publishable-key` and the server Core's secret key aligned to the same Stripe account**. The Shell (browser) is bound to `publishable-key`, the Core (server) holds the secret key via its injected `IStripeProvider`. A `publishable-key` swap invalidates cached Stripe.js and cancels the orphan intent on the *previously active* account, but it does NOT reconfigure the Core — the Core will keep creating intents under the old secret key until you construct a new `StripeCore` with a provider pointing at the new account. For multi-account routing, build one Core per account and route requests before they reach `requestIntent`.

Core observability events include `stripe-checkout:webhook-deduped` with `detail: { eventId, type }` whenever a duplicate authenticated webhook is suppressed by the dedup window, including a duplicate that waited for an in-flight first delivery and resolves because that delivery succeeded. A disposed Core dispatches neither it nor `stripe-checkout:webhook-warning`.

## Install

```bash
npm install @csbc-dev/stripe stripe @stripe/stripe-js
```

`stripe` (server SDK) and `@stripe/stripe-js` (browser loader) are declared as optional peer dependencies. Install whichever side you consume.

`@wc-bindable/core` and `@wc-bindable/remote` come in as regular dependencies (`^0.10.0`). Remote 0.10 enforces strict JSON values on the wire: an object member set to `undefined` (or a `Date`, `NaN`, class instance, …) rejects the whole value instead of being silently dropped. If your server wires the Core with its own `RemoteShellProxy`, use `@wc-bindable/remote` 0.10 or newer there too. The Core never forwards a provider's objects to observable state: from what `createPaymentIntent` / `retrieveIntent` return it rebuilds `amount` as `{ value, currency }` (finite number, non-empty string) and `paymentMethod` as `{ id, brand, last4 }` (non-empty strings, length-capped), so extra fields or non-JSON members from a custom `IStripeProvider` never reach the browser, and a value that does not fit is treated as not returned. A `retrieveIntent` result that is not an object counts as no answer, and a `status` that is not a string is handled as an unknown status whose `stripe-checkout:unknown-status` detail carries `status: ""` plus the value's type in `reason`, never the value. A rejected command's `code` now crosses the wire as well (still limited to the sanitizer's allowlist). See SPEC.md §8 for the wire shapes.

## License

MIT. See [LICENSE](./LICENSE).
