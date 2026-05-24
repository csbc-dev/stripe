# Examples conventions

Rules every example under `examples/` follows. Keep new work compliant; if a
rule must change, change it here first.

## 1. Scope — target frameworks

Exactly four front-end demos of `<stripe-checkout>`, each binding the element a
different way (and nothing else — keep the set focused):

| Example | Binding |
|---|---|
| `vanilla` | [`@wc-bindable/core`](https://www.npmjs.com/package/@wc-bindable/core) `bind()` |
| `react` | [`@wc-bindable/react`](https://www.npmjs.com/package/@wc-bindable/react) `useWcBindable` |
| `vue` | [`@wc-bindable/vue`](https://www.npmjs.com/package/@wc-bindable/vue) `useWcBindable` |
| `wcstack-state` | [`@wcstack/state`](https://www.npmjs.com/package/@wcstack/state) declarative `data-wcs` |

Use the **off-the-shelf adapter** for each framework — no hand-written binding
glue. All four render an **identical checkout card** (amount display, the Stripe
Payment Element mount point, Pay/Reset, live status pill, a `requires_action`
/ `processing` state, a result block showing `brand •• last4`, error banner);
they differ only in **how** the framework layer subscribes to
`<stripe-checkout>`'s reactive state.

## 2. Architecture — two servers, remote-only (Case C)

Like webauthn and s3-uploader, there are **two** backends — the second is a Core
host over WebSocket (like s3-uploader, not webauthn's cross-origin RP), but the
sensitive data path is direct browser → **Stripe** (card details POST from
inside the Stripe Elements iframe, not from app code).

| Server | Port(s) | Role |
|---|---|---|
| `server/` | `ws://…:8787/stripe` + `POST /webhooks/stripe` (+ `GET /health`) | The **Core host** (analogous to s3-uploader's `server/`): per-connection `StripeCore` + provider + `RemoteShellProxy`. The *only* place `STRIPE_SECRET_KEY` lives, where the `IntentBuilder` computes the amount, where PaymentIntent / SetupIntent are created, and where Stripe webhooks are verified + dispatched. Runs via `tsx` (type-checked, not bundled). Shared by all clients. |
| `delivery/` | `5173`/`5174`/`5175`/`5176` | **One** dependency-free static delivery server. Serves each built client (and `wcstack-state` verbatim, plus the `/vendor/*` build it imports) at its fixed port. Holds no secret key; no card data passes through it. |

- **Remote-only — there is no local mode worth shipping.** Putting
  `STRIPE_SECRET_KEY` in the browser is a non-starter, so every client connects
  to the server-side Core over WebSocket via `RemoteCoreProxy` ⇄
  `RemoteShellProxy`.
- **Card data never crosses the WebSocket.** Stripe Elements POSTs the card
  **directly to Stripe** from inside its sandboxed iframe. Only the
  `requestIntent` RPC, `reportConfirmation` outcomes, and webhook-driven status
  updates cross the WS — never a card field. This is what keeps PCI scope
  contained; routing any `card_number` through the Core is a CSBC violation.
- **But the `clientSecret` *does* cross the WebSocket** (it is the result of the
  `requestIntent` RPC — Stripe.js's `confirmPayment` is authorized solely by
  knowing it). It is a bearer credential for the intent, so **the wire must be
  `wss://` in production**. `setConfig` rejects `ws://` against a non-loopback
  host for exactly this reason (loopback + `NODE_ENV=test` are the only escapes).
  This is the stripe-specific twist versus s3-uploader, where nothing secret
  rides the socket.
- **The server decides the amount.** The `IntentBuilder` registered on the Core
  computes `amount` / `currency` / `customer` from the **authenticated**
  `UserContext` (in the demo, `resolveCart()`), never from the client. The
  Shell's `amount-value` / `amount-currency` inputs are forwarded only as an
  advisory `hint` and are tampered-with by definition — a client cannot set its
  own price. This is s3-uploader's "pin `bucket`/`prefix` server-side" invariant,
  re-cast as "pin the price server-side."
- **`ws.on("close", …)` disposes the per-connection Core, but is not the
  payment-integrity guarantee.** Unlike s3-uploader's load-bearing
  `ws.on("close", () => core.abort())` (the only path that can reach
  `abortMultipart` and avoid orphan S3 parts), an abandoned Stripe intent is
  **not** an orphan the close handler must clean up: Stripe expires unconfirmed
  intents on its own and the **webhook is the authority** on terminal state. The
  close handler disposes the `RemoteShellProxy` + `StripeCore` to free
  per-connection resources; correctness comes from webhook reconciliation, not
  from the close handler.

## 3. Two run modes, one build — mock by default, real test keys opt-in

Every example runs in **two modes with zero code changes** — the only difference
is whether you set env vars:

- **Mock (default, no Stripe account).** The server injects an in-memory
  `MockStripeProvider`; the browser swaps Stripe.js for a fake loader via
  `WcsStripe.setLoader(...)`. The full `idle → collecting → processing →
  succeeded` lifecycle runs deterministically — ideal for learning the binding
  and for CI.
- **Real test mode.** Set `STRIPE_SECRET_KEY` (server) and
  `VITE_STRIPE_PUBLISHABLE_KEY` (client); the server uses `StripeSdkProvider`,
  the browser loads real Stripe.js, and you pay with test card
  `4242 4242 4242 4242`.

The switch is presence-based: a client is in mock mode **iff**
`VITE_STRIPE_PUBLISHABLE_KEY` is unset (`stripe-setup.ts` exports `IS_MOCK`).
The `wcstack-state` example is the one exception: because it is buildless, it
does not read Vite env and instead switches via the inline `PUBLISHABLE_KEY`
sentinel in `index.html` (§6). The server switches on `STRIPE_SECRET_KEY`
(`makeCore.ts`). Keep both halves of the switch in lockstep so a
half-configured run fails loud, not silently.

## 4. Build, then serve statically — not the Vite dev server

Matching s3-uploader: the three Vite clients are **built**, and the shared
[`delivery/`](./delivery/) server serves the output. The canonical run is
**build + static serve**, not `npm run dev`.

- `vanilla` / `react` / `vue` build with `npm run build` → `dist/` (the
  `tsc --noEmit` typecheck runs first, `vue-tsc` for vue).
  `delivery/server.js` serves each `dist/` at its port root.
- **Do not serve via the Vite dev server** for the canonical run. `npm run dev`
  exists only for hot-reload during development (it hits the same Core host over
  WebSocket on its dev port).
- `delivery/` is dependency-free (Node built-ins only). Register a new client by
  adding its port + `dist` dir to [`delivery/server.js`](./delivery/server.js).
- `vite.config` sets `base: "./"` so built asset URLs are relative and resolve
  when `delivery/` serves the `dist/` at a port root.
- The WS URL is read from `import.meta.env.VITE_REMOTE_CORE_URL` (each client's
  `.env`, default `ws://localhost:8787/stripe`) and applied through
  `bootstrapStripe({ remote: { enableRemote: true, remoteSettingType: "config",
  remoteCoreUrl } })`. **It is baked in at `vite build` time** — set each
  client's `.env` before building, not before serving.
- **In real mode Stripe.js is loaded from `js.stripe.com`, never bundled.**
  Stripe requires Stripe.js to be served from their domain (a self-hosted copy
  breaks PCI eligibility). The package's default loader injects the
  `https://js.stripe.com/v3` script; in mock mode `WcsStripe.setLoader(...)`
  replaces it entirely so no network call is made. Do not vendor Stripe.js.

## 5. Card entry is always inside the iframe; the *pay* gesture may not be

- **No client ever touches a card field.** The card lives entirely inside the
  Stripe Elements iframe the Shell mounts (a placeholder in mock mode) —
  application JS cannot read or set it. This is the PCI invariant, and the analog
  of s3-uploader's "a `File` cannot travel through a reactive binding."
- **`publishable-key` and `return-url` are set on the element**, not bound.
  `publishable-key` is the browser-safe key (set as an attribute); `return-url`
  is read by the Shell inside `submit()` for the 3DS redirect return — set it to
  a URL that resolves back to **this client's served page**
  (`location.origin + location.pathname`, §7).
- Driving the flow differs by client: `vanilla` / `react` / `vue` call
  `el.submit()` imperatively (the element auto-prepares — creates the intent +
  mounts Elements — once `publishable-key` is set); `wcstack-state` calls
  `submit()` from a `<wcs-state>` method. The reactive `trigger` input
  (`WcsStripeValues.trigger`) is the declarative alternative to `submit()` and is
  reset by the Shell when the run settles.
- Everything downstream — `status` / `loading` / `amount` / `paymentMethod`
  (`{ id, brand, last4 }`) / `intentId` / `error` — is fully reactive
  everywhere.
- Keep the `StripeError` → string normalizer (renders `message` + `code`)
  logically identical across all four clients.

## 6. `wcstack-state` specifics

- **Single self-contained file** — one `index.html`, no bundler, no build step:
  the inline `<wcs-state>` state, the `data-wcs` bindings, the setup module, and
  the CSS all live in that one file. The [`delivery/`](./delivery/) server serves
  it **verbatim** at port 5176. The one [`README`](./wcstack-state/README.md)
  documents the pre-publish CDN swap.
- **CDN for the runtime**: `@wcstack/state` →
  `https://esm.run/@wcstack/state@1/auto` (pinned to a major so a breaking
  release can't silently break the buildless file). The `/auto` entry registers
  `<wcs-state>` on load — no bootstrap call for the runtime.
- **`@csbc-dev/stripe` is resolved by an `<importmap>`.** The package has no
  side-effect `/auto` entry, so registration of `<stripe-checkout>` is explicit:
  an inline `<script type="module">` imports `bootstrapStripe` and calls it.
  Until the package is published, the importmap points the bare specifiers at the
  **local repo build** that `delivery/` serves under `/vendor/*`
  (`@csbc-dev/stripe` → `/vendor/csbc/index.js`, plus the `@wc-bindable/*` deps
  it reaches → `/vendor/wcb-core/`, `/vendor/wcb-remote/`). After publishing,
  swap those to pinned `https://esm.run/@csbc-dev/stripe` URLs. `@wc-bindable/*`
  is pinned at the version the package depends on (`^0.4.0`) so the wire/protocol
  version stays stable.
- **Ordering**: the inline setup module (which `bootstrapStripe()`s and so
  defines `<stripe-checkout>`) must appear **before** the `@wcstack/state/auto`
  script, so by the time `<wcs-state>` scans `data-wcs` the element is upgraded
  and its `static wcBindable` is readable. Module scripts execute in document
  order.
- **Bindings follow the current `@wcstack/state` spec** — `data-wcs` directives,
  text via `textContent:`, conditionals via `if:` on `<template>`, and command
  invocation. The element's `wcBindable.commands` already uses the object form
  required by `@wcstack/state` ≥ 1.9.1. When `@wcstack/state` ships a new spec,
  re-verify the binding names — a stale guess is a bug.

## 7. Ports & origins — the 3DS return URL and the webhook endpoint

Ports are **fixed**: `react 5173`, `vue 5174`, `vanilla 5175`,
`wcstack-state 5176`, server `8787` (WebSocket + webhook HTTP).

The four client ports are owned by [`delivery/server.js`](./delivery/server.js)
(and mirrored by each Vite client's `server.port` + `strictPort: true` for the
`dev` path). Unlike s3-uploader, **there is no bucket-CORS analog to maintain** —
Stripe Elements works from any origin given a valid publishable key, so a client
port is not an entry on an allow-list at Stripe. Two origin-shaped concerns do
exist:

- **The 3DS `return-url`** each client passes must resolve back to that client's
  served origin/port, so the post-3DS redirect lands on the same page. The
  clients derive it as `location.origin + location.pathname`, so it tracks the
  served port automatically.
- **The webhook endpoint** Stripe POSTs to must point at the Core host's HTTP
  route (`stripe listen --forward-to localhost:8787/webhooks/stripe`, or a
  Dashboard endpoint). If the server port changes, update the forward target —
  and `STRIPE_WEBHOOK_SECRET` must match.

If the WS port changes, update it everywhere by hand — the clients'
`VITE_REMOTE_CORE_URL` and `wcstack-state`'s inline `remoteCoreUrl` are **not**
derived from the server's `PORT`.

## 8. Demo-only shortcuts (never ship)

These keep the demos small; production must replace them:

- **No auth on the WS upgrade.** The `IntentBuilder`'s `UserContext` is faked
  (`{ sub: "demo-user", sessionId }`), so the amount is not bound to a real
  user. In production, derive `UserContext` from an **authenticated** session
  checked during the WS upgrade, and compute the amount/customer from the
  verified user — never from the client hint.
- **`MockStripeProvider` / test keys.** The default mock provider does **no**
  HMAC verification (`verifyWebhook` just parses JSON), so the server forces
  `webhookSecret` to `undefined` in mock mode and skips verification. Never put
  live keys in an example; real runs use `pk_test_…` / `sk_test_…`.
- **`STRIPE_SECRET_KEY` in `server/.env`.** Fine for a local demo; a real
  deployment reads it from a secret manager / instance role, not a key on disk.
- **`resolveCart()` returns a fixed cart.** A real app loads the authoritative
  order total from the DB keyed by the authenticated user. The browser's
  `amount-value` hint stays advisory either way (CSBC: "the server decides the
  amount").
- **The webhook fan-out is example-grade.** `server/src/index.ts` delivers each
  verified event to *every* live Core (each dedups by `event.id`); the handler
  just logs. A real multi-tenant server routes by `intentId` to the owning
  session, reconciles the order (mark paid, fulfill, receipt), and is
  **idempotent on `event.id`** with durable storage. Verification always runs
  against the **raw, byte-for-byte** body — never a re-serialized JSON body.

## 9. Adding a new example

1. **Vite framework client**: create the project; depend on
   `@csbc-dev/stripe` via `file:../..` and the framework's `@wc-bindable/*`
   adapter (`^0.4.0`); read the WS URL from `VITE_REMOTE_CORE_URL`;
   `bootstrapStripe({ remote: … })`; honor the mock/real switch via
   `VITE_STRIPE_PUBLISHABLE_KEY`; render the same checkout-card surface; set
   `publishable-key` + a `return-url` of `location.origin + location.pathname`;
   `vite build` with `base: "./"`; register the port + `dist` dir in
   [`delivery/server.js`](./delivery/server.js).
2. **Declarative (wcstack-style)**: a single self-contained file with an inline
   `bootstrapStripe(...)` module, an `<importmap>` to the `/vendor/*` local build
   (or published CDN), and `data-wcs` on `<stripe-checkout>`, served verbatim by
   `delivery/` on a fixed port.

No new backend — every client shares the one Core host (`server/`) and is served
by the one static `delivery/`.

## Layout

```
examples/
  server/         Core host (ws://…:8787/stripe + /webhooks/stripe) — per-conn StripeCore, IntentBuilder, webhook verify/dispatch (tsx)
  delivery/       static delivery (5173/5174/5175/5176) — serves the built clients + wcstack /vendor build
  react/          Vite + @wc-bindable/react  useWcBindable   → dist/  (served on 5173)
  vue/            Vite + @wc-bindable/vue     useWcBindable   → dist/  (served on 5174)
  vanilla/        Vite + @wc-bindable/core    bind()          → dist/  (served on 5175)
  wcstack-state/  single self-contained file + @wcstack/state (no build, served verbatim on 5176)
```

See [README.md](./README.md) for run instructions.
