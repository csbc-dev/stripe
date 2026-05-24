# @wcstack/state example (buildless, single file)

Binds `<stripe-checkout>` to [`@wcstack/state`](https://www.npmjs.com/package/@wcstack/state) **declaratively** with `data-wcs` attributes — no framework, no bundler, **one file**.

```html
<stripe-checkout
  data-wcs="
    mode: mode; amountValue: amountValue; amountCurrency: amountCurrency;
    status: status; loading: loading; amount: amount;
    paymentMethod: paymentMethod; intentId: intentId; error: error
  "
></stripe-checkout>
```

`@wcstack/state` implements wc-bindable-protocol, so each name in `data-wcs` maps to the matching `<stripe-checkout>` bindable property: **inputs** (`mode`, `amountValue`, `amountCurrency`) flow store → element; **outputs** (`status`, `loading`, `amount`, `paymentMethod`, `intentId`, `error`) flow element → store. Commands (`submit()` / `reset()`) are called imperatively from `<wcs-state>` methods (`pay()` / `resetCheckout()`).

## One self-contained file

Everything — the inline `<wcs-state>` store, the `data-wcs` bindings, the setup
module that `bootstrapStripe()`s and registers `<stripe-checkout>`, and the CSS —
lives in [`index.html`](./index.html). There is no build step and no per-example
server: the shared [`../delivery`](../delivery) server serves this file
**verbatim** on port 5176, and also mounts the local repo build under `/vendor/*`
so the page's `<importmap>` can resolve `@csbc-dev/stripe` (and its
`@wc-bindable/*` deps) without a bundler. `@wcstack/state` itself comes from the
esm.run CDN.

## Run

```bash
# from the repo root, once — builds the package that /vendor/* serves:
npm install && npm run build

# terminal 1 — shared Core server (ws://localhost:8787/stripe)
cd examples/server && npm install && npm run dev

# terminal 2 — shared static delivery (serves this file on :5176)
cd examples/delivery && npm start
```

Then open <http://localhost:5176>.

## Real Stripe test keys

This example defaults to mock mode. To use real **test** keys:

1. In [`index.html`](./index.html)'s setup module, set `PUBLISHABLE_KEY` to your `pk_test_...`.
2. Start the server with `STRIPE_SECRET_KEY` set (see [`../server/.env.example`](../server/.env.example)).
3. Pay with test card `4242 4242 4242 4242`.

## After the package is published

Swap the `<importmap>` `/vendor/*` entries for pinned CDN URLs, e.g.
`"@csbc-dev/stripe": "https://esm.run/@csbc-dev/stripe@<version>"`, keeping
`@wc-bindable/*` at the version the package depends on (`0.4.0`) so the
wire/protocol version stays stable. Once that swap is done the page no longer
needs the `/vendor/*` mounts and could be hosted on any static host.
