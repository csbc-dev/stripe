# @wcstack/state example (buildless)

Binds `<stripe-checkout>` to [`@wcstack/state`](https://www.npmjs.com/package/@wcstack/state) **declaratively** with `data-wcs` attributes — no framework, no bundler.

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

## Why no Vite here

`@wcstack/state` is buildless by design — it reads the inline `<wcs-state>` module script and the `data-wcs` attributes at runtime. A bundler would rewrite that inline module and break it. So this example ships a tiny dependency-free static server (`server.js`) that:

- serves the local `@csbc-dev/stripe` build + its `@wc-bindable/*` deps under `/vendor/*`, and
- lets the HTML `<importmap>` resolve those bare specifiers (`@wcstack/state` itself comes from the esm.run CDN).

## Run

```bash
# from the repo root, once:
npm install && npm run build

# terminal 1 — shared Core server
cd examples/server && npm install && npm run dev

# terminal 2 — this example
cd examples/wcstack-state && npm run dev     # http://localhost:5176
```

## Real Stripe test keys

This example defaults to mock mode. To use real **test** keys:

1. Edit `setup.js` → set `PUBLISHABLE_KEY` to your `pk_test_...`.
2. Start the server with `STRIPE_SECRET_KEY` set (see [`../server/.env.example`](../server/.env.example)).
3. Pay with test card `4242 4242 4242 4242`.
