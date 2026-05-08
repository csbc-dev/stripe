# CLAUDE.md

This repository (`@csbc-dev/stripe`) was forked from [`@wc-bindable/stripe`](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/packages/stripe) and re-packaged as part of the csbc-dev/arch family of architectures. Two background documents are summarized below as prerequisites for understanding the design intent, followed by a section specific to this package.

---

## 1. wc-bindable-protocol overview

A framework-agnostic, minimal protocol that lets any class extending `EventTarget` declare its own reactive properties. It allows the reactivity systems of React / Vue / Svelte / Angular / Solid (and others) to bind to arbitrary components without writing framework-specific glue code.

### Core idea

- The component author declares **what** is bindable.
- The framework consumer decides **how** to bind it.
- Neither side needs to know about the other.

### How to declare

Just put a schema on the `static wcBindable` field.

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs:   [{ name: "url" }, { name: "method" }],   // optional
    commands: [{ name: "fetch", async: true }, { name: "abort" }],  // optional
  };
}
```

| Field | Required | Role |
|---|---|---|
| `properties` | ✅ | Properties whose state changes are notified through `CustomEvent` (output) |
| `inputs` | — | Configurable properties (input; declaration-only, no automatic sync) |
| `commands` | — | Invocable methods (intended for remote proxies / tooling) |

### How binding works

An adapter only has to:

1. Read `target.constructor.wcBindable`.
2. Verify `protocol === "wc-bindable" && version === 1`.
3. For each `property`, read `target[name]` synchronously to deliver the initial value, then subscribe to `event`.

A working `bind()` is implementable in roughly 20 lines. A framework adapter fits in tens of lines.

### Out of scope (intentionally)

- Automatic two-way sync (input reflection is the caller's responsibility).
- Form integration.
- SSR / hydration.
- Value type or schema validation.

### Why EventTarget

Setting the minimum requirement to `EventTarget` rather than `HTMLElement` lets the same protocol run in non-browser runtimes such as Node.js / Deno / Cloudflare Workers. Because `HTMLElement` is a subclass of `EventTarget`, Web Components are automatically compatible.

Reference: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Core/Shell Bindable Component (CSBC) architecture overview

An architecture built on top of wc-bindable-protocol that **moves business logic — particularly async logic — out of the framework layer and into the Web Component**, structurally eliminating framework lock-in.

### The problem it solves

The real source of framework migration cost is not UI compatibility but **async logic that is tightly coupled to framework-specific lifecycle APIs (`useEffect` / `onMounted` / `onMount`, …)**. Templates can be rewritten mechanically, but async code requires semantic understanding, so its porting cost explodes.

### Three-layer structure

1. **Headless Web Component layer** — encapsulates async work (fetch / WebSocket / timers / …) and state (`value`, `loading`, `error`, …) internally. It has no UI; it acts as a pure service layer.
2. **Protocol layer (wc-bindable-protocol)** — exposes the above state externally via `static wcBindable` + `CustomEvent`.
3. **Framework layer** — connects to the protocol with a thin adapter and renders the received state. **No async code is written here at all.**

### Core / Shell separation

The headless layer is further split into two. **The single invariant is not "the Shell is always thin" but where authority lives**:

- **Core (`EventTarget`) — owns decisions.**
  Business logic, policy, state transitions, authorization-related behavior, event dispatch. If kept DOM-independent, it is portable to Node.js / Deno / Workers.
- **Shell (`HTMLElement`) — owns only execution that cannot be delegated.**
  Framework hookup, DOM lifecycle, work that can only run in a browser.

The design key is the **target injection** pattern: the Core's constructor accepts an arbitrary `EventTarget` and dispatches every event to it. When the Shell passes `this`, Core events fire directly from the DOM element and no re-dispatch is needed.

### Four canonical cases

| Case | Core location | Shell role | Examples |
|---|---|---|---|
| A | Browser | Thin wrapper over a browser-bound Core | `auth0-gate` (local) |
| B1 | Server | Thin Shell that proxies / mediates commands | `ai-agent` (remote) |
| B2 | Server | Observation-only thin Shell (subscribes to a remote session) | `feature-flags` |
| C | Server | Shell that drives a browser-anchored data plane | `s3-uploader`, `passkey-auth`, **`stripe-checkout`** |

Case C is a **first-class case** of CSBC. It arises when there is a data plane that can only execute in the browser — direct upload, WebRTC, WebUSB, the `File System Access API`, work that requires a user gesture, Stripe Elements (used to keep PCI scope contained), and so on. A thicker Shell is **not** a CSBC violation as long as the **decisions stay in the Core**.

> Invariant:
> **The Core owns every decision. The Shell owns only execution that cannot be delegated.**

### Three boundaries that are crossed

| Boundary | Crossing party | Mechanism |
|---|---|---|
| Runtime boundary | Core (`EventTarget`) | DOM-independent; runs on Node / Deno / Workers |
| Framework boundary | Shell (`HTMLElement`) | Attribute mapping + `ref` binding |
| Network boundary | `@wc-bindable/remote` | Proxy EventTarget + JSON wire protocol |

`@wc-bindable/remote` is a `RemoteShellProxy` (server side) / `RemoteCoreProxy` (client side) pair that pushes the Core entirely onto the server while keeping the client-side `bind()` unchanged. The default transport is WebSocket, but anything that satisfies the minimal `ClientTransport` / `ServerTransport` interface — MessagePort, BroadcastChannel, WebTransport, etc. — is a drop-in.

### Where this package sits

`@csbc-dev/stripe` is **Case C**: every Stripe payment decision (creating PaymentIntents / SetupIntents, verifying webhooks, authorizing 3DS resume) is held server-side by `StripeCore` (the Core, an `EventTarget`), while `<stripe-checkout>` (the Shell, an `HTMLElement`) handles the browser-only data plane — loading Stripe.js, mounting the Payment Element inside a Stripe-sandboxed iframe, calling `confirmPayment` / `confirmSetup`, and handling the 3DS redirect return.

Card data never traverses the WebSocket (Stripe Elements POSTs directly from inside its iframe to Stripe). Only intent-creation requests, confirmation outcomes, and webhook-driven status updates flow through the server. This keeps `STRIPE_SECRET_KEY` out of the browser, prevents PCI scope expansion, and preserves the CSBC invariant that "the Core owns decisions and the Shell owns only execution that cannot be delegated."

Reference: [csbc-dev/arch](https://github.com/csbc-dev/arch/blob/main/README.md)

---

## 3. This package — `@csbc-dev/stripe`

A headless Stripe payments component built on wc-bindable-protocol. It is **not** a visual UI widget — it is an **I/O node** that wires Stripe's PaymentIntent / SetupIntent + Elements flow into reactive state, with PCI-safe card entry, 3DS redirect handling, and server-side webhook reconciliation.

### Bindable surface (the `wcBindable` contract)

Defined in [src/core/wcBindable.ts](src/core/wcBindable.ts). The Shell extends this descriptor with one additional input (`publishable-key`) and the imperative `submit()` / `prepare()` / `reset()` / `abort()` commands.

- **Inputs**: `mode`, `amountValue`, `amountCurrency`, `customerId` (and `publishable-key` on the Shell).
- **Outputs**: `status`, `loading`, `amount`, `paymentMethod`, `intentId`, `error`.
- **Commands**: `requestIntent`, `reportConfirmation`, `cancelIntent`, `resumeIntent`, `reset`.

`status` follows the lifecycle `idle → collecting → processing → (requires_action →) succeeded | failed`. See [src/types.ts](src/types.ts#L71-L77) for the canonical union.

### Source layout

| Path | Role |
|---|---|
| [src/core/StripeCore.ts](src/core/StripeCore.ts) | The Core (`EventTarget`). Owns intent creation, webhook verification + dispatch, 3DS resume authorization, status state machine. Server-only — imports `node:crypto` for the constant-time `clientSecret` compare. |
| [src/core/wcBindable.ts](src/core/wcBindable.ts) | The `wcBindable` descriptor for `StripeCore`. Split out so the browser graph never transitively pulls `StripeCore.ts` and its `node:crypto` dependency. |
| [src/components/Stripe.ts](src/components/Stripe.ts) | The Shell (`<stripe-checkout>` Custom Element). Loads Stripe.js, mounts the Payment Element in a Stripe-sandboxed iframe, drives `confirmPayment` / `confirmSetup`, handles 3DS redirect return. Guards its `HTMLElement` base with a `typeof` fallback so the browser barrel stays evaluable under plain Node. |
| [src/providers/StripeSdkProvider.ts](src/providers/StripeSdkProvider.ts) | Default `IStripeProvider` adapter over stripe-node. Holds the secret key. |
| [src/types.ts](src/types.ts) | All public types. The provider seam (`IStripeProvider`), the `IntentBuilder` contract, and the observable shapes (`WcsStripeCoreValues`, `WcsStripeValues`) live here. |
| [src/index.ts](src/index.ts) | Browser barrel. Re-exports `<stripe-checkout>` and config helpers. **Must not** re-export `StripeCore` / `StripeSdkProvider`. |
| [src/server.ts](src/server.ts) | Server entry (`@csbc-dev/stripe/server`). Re-exports `StripeCore` / `StripeSdkProvider`. |
| [src/config.ts](src/config.ts) | Module configuration — custom-element tag name and remote (WebSocket) transport settings. Setters validate atomically. |
| [src/bootstrapStripe.ts](src/bootstrapStripe.ts), [src/registerComponents.ts](src/registerComponents.ts) | Browser-side bootstrap that calls `customElements.define`. Idempotent on the same class; fails loud on a tag-name collision with a different class. |
| [src/internal/paymentMethodShape.ts](src/internal/paymentMethodShape.ts) | Internal helper for narrowing the observable `paymentMethod` view. |
| [SPEC.md](SPEC.md) | Full protocol specification — state machine, wcBindable surface, 3DS resume authorization model, PCI scope invariants, webhook pipeline, security (§9). |

### Two entry points (do not blur them)

- `@csbc-dev/stripe` — **browser barrel**. Re-exports `<stripe-checkout>` (extends `HTMLElement`). Designed to be evaluable under plain Node (for SSR pre-render, test pre-scanners, bundler graph walks) but not functional there.
- `@csbc-dev/stripe/server` — **server entry**. Re-exports `StripeCore`, `StripeSdkProvider`, and types. This is the only entry that pulls in `node:crypto`.

The split is enforced by [src/core/wcBindable.ts](src/core/wcBindable.ts): the Shell needs `StripeCore.wcBindable` at module scope, but importing `StripeCore` directly would drag `node:crypto` into the browser graph. The descriptor lives in its own module so the Shell consumes only the descriptor (and a `import type { StripeCore }` slot, which is erased at emit time).

### Non-negotiable invariants

These are properties the implementation must preserve. Several are the reason for non-obvious code shapes; before refactoring near them, read SPEC.md §9.

- **The server decides the amount.** `IntentBuilder` must compute amount / currency / customer from authenticated user context. `request.hint.amountValue` is advisory and tampered-with by definition.
- **Card data never crosses the WebSocket.** Stripe Elements POSTs directly to Stripe from its iframe. Anything that would route a `card_number` field through the Core is a CSBC violation.
- **Idempotent intent creation.** `StripeSdkProvider` accepts `buildIdempotencyKey`; without it, network flake creates duplicate intents.
- **Raw webhook body, byte-for-byte.** Signature verification needs the unparsed bytes Stripe sent — preserve them before any JSON middleware runs.
- **3DS resume needs `clientSecret` proof.** `StripeCore.resumeIntent` does a constant-time compare against the Stripe-issued value (hence `node:crypto`). `clientSecret` MUST NOT appear on observable state, `CustomEvent.detail`, attributes, dataset, or logs. `registerResumeAuthorizer` is a defense-in-depth hook for layered tenant isolation.
- **Errors are sanitized at the wire.** `StripeError` keeps `code` / `declineCode` / `type`; raw SDK errors collapse to a generic `"Payment failed."` Do not fake Stripe type tokens (`Object.assign(err, { type: "card_error" })`) on user errors to bypass the allowlist.

### Tests

| Path | What it covers |
|---|---|
| [__tests__/stripeCore.test.ts](__tests__/stripeCore.test.ts) | Core state machine, IntentBuilder, webhook dedup, 3DS resume auth (constant-time compare, authorizer hook). |
| [__tests__/stripeShell.test.ts](__tests__/stripeShell.test.ts) | Shell behavior — Elements mount, `confirmPayment` / `confirmSetup`, 3DS redirect-return, abort/disconnect cleanup. Uses happy-dom. |
| [__tests__/stripeSdkProvider.test.ts](__tests__/stripeSdkProvider.test.ts) | `StripeSdkProvider` adapter — idempotency key plumbing, retrieve / cancel routing. |
| [__tests__/config.test.ts](__tests__/config.test.ts) | `setConfig` validation, atomic commit, deep-freeze. |
| [__tests__/nodeRootImport.test.ts](__tests__/nodeRootImport.test.ts) | Asserts that the bare `@csbc-dev/stripe` barrel is evaluable under plain Node (no `HTMLElement is not defined`). |
| [tests/integration/](tests/integration/) | Playwright end-to-end tests (run with `npm run test:integration`). |

### Build and test commands

| Command | Effect |
|---|---|
| `npm run build` | `tsc` — emits `dist/`. |
| `npm run dev` | `tsc --watch`. |
| `npm test` | `vitest run __tests__` (unit + happy-dom). |
| `npm run test:watch` | Same, in watch mode. |
| `npm run test:ci` | `npm run build && vitest run __tests__`. |
| `npm run test:integration` | `npm run build && playwright test` against `tests/integration/`. |
