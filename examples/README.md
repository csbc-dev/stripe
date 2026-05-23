# `@csbc-dev/stripe` examples

Runnable examples that bind `<stripe-checkout>` into four front-end stacks:

| Example | Stack | Binding layer |
|---|---|---|
| [`react/`](./react) | React 19 + Vite | [`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react) — `useWcBindable()` hook |
| [`vue/`](./vue) | Vue 3 + Vite | [`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue) — `useWcBindable()` composable |
| [`vanilla/`](./vanilla) | Plain TS + Vite | [`@wc-bindable/core`](https://www.npmjs.com/package/@wc-bindable/core) — `bind()` (the ~20-line primitive every adapter is built on) |
| [`wcstack-state/`](./wcstack-state) | [`@wcstack/state`](https://www.npmjs.com/package/@wcstack/state) + Vite | `data-wcs` declarative attribute binding |

All four talk to **one** [`server/`](./server) — a Node process that hosts the server-side `StripeCore` and bridges it to each browser `<stripe-checkout>` over a WebSocket (`@wc-bindable/remote`). This is the **CSBC Case C** shape: every payment decision lives in the Core on the server; the browser Shell only runs the Stripe Elements data plane that cannot leave the browser.

```
┌──────────────────────────────┐         ws://localhost:8787/stripe        ┌────────────────────────────┐
│  Browser (any of the 4 apps) │  ◄──────────────────────────────────────► │  server/  (Node)           │
│                              │      @wc-bindable/remote wire protocol      │                            │
│  <stripe-checkout>  (Shell)  │                                            │  RemoteShellProxy          │
│   ├─ loads Stripe.js         │                                            │   └─ StripeCore  (Core)    │
│   ├─ mounts Payment Element  │                                            │       ├─ IntentBuilder     │
│   └─ confirmPayment()        │   card data ──► Stripe (never the WS) ◄──  │       └─ IStripeProvider   │
└──────────────────────────────┘                                            └────────────────────────────┘
```

> **Card data never crosses the WebSocket.** Stripe Elements posts it directly to Stripe from inside its iframe. Only intent-creation requests, confirmation outcomes, and webhook-driven status updates flow through `server/`.

## Mock vs. real Stripe

Every example runs in **two modes** with zero code changes — the difference is purely whether you set environment variables:

- **Mock (default, no Stripe account needed).** The server uses an in-memory `MockStripeProvider` and the browser swaps in a fake Stripe.js via `WcsStripe.setLoader(...)`. The full lifecycle (`idle → collecting → processing → succeeded`) runs deterministically — perfect for understanding the binding and for CI.
- **Real test mode.** Set `STRIPE_SECRET_KEY` (server) and `VITE_STRIPE_PUBLISHABLE_KEY` (front-end) to your Stripe **test** keys. The server uses `StripeSdkProvider`, the browser loads real Stripe.js, and you pay with test card `4242 4242 4242 4242` (any future expiry, any CVC, any postal code).

See each example's `.env.example`.

## Run it

### 1. Build the package once (from the repo root)

The examples consume `@csbc-dev/stripe` via a local `file:../..` dependency, which resolves to the built `dist/`:

```bash
# repo root  (…/csbc-dev/stripe)
npm install
npm run build
```

> Re-run `npm run build` (or `npm run dev` for watch mode) whenever you change the package source.

### 2. Start the shared server

```bash
cd examples/server
npm install
npm run dev          # ws://localhost:8787/stripe   ·   http://localhost:8787/webhooks/stripe
```

By default it logs `MOCK mode`. To run against real Stripe test keys, copy `.env.example` to `.env` and fill in `STRIPE_SECRET_KEY` first.

### 3. Start any front-end (in a second terminal)

```bash
cd examples/react      # or vue / vanilla / wcstack-state
npm install
npm run dev            # open the printed URL (each app uses its own port — see below)
```

Each front-end runs on a fixed port so you can run several side by side:

| Example | URL |
|---|---|
| `react/` | http://localhost:5173 |
| `vue/` | http://localhost:5174 |
| `vanilla/` | http://localhost:5175 |
| `wcstack-state/` | http://localhost:5176 |

Open the app, watch `<stripe-checkout>` auto-mount its (mock or real) Payment Element, click **Pay**, and see `status`/`amount`/`paymentMethod` flow back into the framework's reactive state.

## What each example demonstrates

Every example does the same four things — only the *binding idiom* differs:

1. **Configure remote mode + the Stripe.js loader** before the element connects (`bootstrapStripe(...)`, `WcsStripe.setLoader(...)` in mock mode). See each app's `stripe-setup`.
2. **Read outputs reactively** — `status`, `loading`, `amount`, `paymentMethod`, `intentId`, `error` — sourced from the `stripe-checkout:*-changed` CustomEvents.
3. **Drive inputs declaratively** — `mode`, `amount-value`, `amount-currency`, `customer-id`, `publishable-key`, `return-url`.
4. **Invoke commands** — `submit()` (or the reactive `trigger` boolean), plus `reset()` / `abort()`.

> The `amount-value` you set in the browser is only a **hint**. The server's `IntentBuilder` ([`server/src/makeCore.ts`](./server/src/makeCore.ts)) computes the authoritative amount — that is why the UI's "total" reflects the server's value, not the attribute. This is the core CSBC invariant: *the Core owns decisions; the Shell owns only execution.*

## Webhooks (optional)

The server exposes `POST /webhooks/stripe`. In mock mode it is a no-op. With real test keys, forward Stripe events to it with the [Stripe CLI](https://stripe.com/docs/stripe-cli):

```bash
stripe listen --forward-to localhost:8787/webhooks/stripe
# copy the printed whsec_... into server/.env as STRIPE_WEBHOOK_SECRET
```

The webhook fan-out in [`server/src/index.ts`](./server/src/index.ts) is **example-grade** (delivers to every live Core; each dedups by `event.id`). Production multi-tenant servers must route by `intentId` to the owning session and add durable, DB-backed idempotency — see [`../README.md`](../README.md#security--your-responsibilities) and [`../SPEC.md`](../SPEC.md) §6.2 / §9.

## Version pinning

The server pins `@wc-bindable/remote@^0.4.0` to match the wire-protocol version that `@csbc-dev/stripe` bundles. The front-ends pin `@wc-bindable/{core,react,vue}@^0.4.0` for the same reason. If you bump `@wc-bindable/*` in the package, bump the examples in lockstep.
