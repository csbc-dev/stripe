import { raiseError } from "../raiseError.js";
import {
  IWcBindable, IStripeProvider, IntentBuilder, IntentRequest, IntentCreationResult,
  IntentRequestHint, ConfirmationReport, WebhookHandler, WebhookRegisterOptions,
  StripeError, StripeEvent, StripeMode, StripeStatus, StripeAmount, StripePaymentMethod,
  UserContext, PaymentIntentOptions, SetupIntentOptions, IntentBuilderResult,
  ResumeAuthorizer, UnknownStatusDetail,
} from "../types.js";
import { extractCardPaymentMethod, validateReportedPaymentMethod } from "../internal/paymentMethodShape.js";
import {
  STRIPE_TAXONOMY_TOKEN_RE,
  STRIPE_ERROR_CODE_RE,
  STRIPE_CLASS_NAME_RE,
  STRIPE_KNOWN_TYPES,
  MAX_ERROR_MESSAGE_LENGTH,
  summarizeUntrustedValue,
} from "../internal/errorTaxonomy.js";
import { STRIPE_CORE_WC_BINDABLE } from "./wcBindable.js";
import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for the clientSecret match in `resumeIntent`.
 * The Stripe-issued clientSecret is a bearer credential on the resume path,
 * so a naive `===` would leak the length of the match prefix through CPU
 * branch timing (measurable over many probes even through network noise).
 *
 * Length caveat: the `timingSafeEqual(aBuf, aBuf)` dummy-compare on the
 * length-mismatch branch does work proportional to `aBuf.length`, i.e. the
 * length of the server-retrieved secret. Stripe's clientSecret format
 * (`{intent_id}_secret_{random}`) has a length that varies only with the
 * intent-id portion, which is itself derived from non-secret Stripe
 * internals — so this residual length signal does not help an attacker
 * forge credentials. The dummy compare is retained because removing it
 * would convert the length-mismatch branch into an early-return whose
 * timing is trivially distinguishable from the equal-length compare.
 */
function clientSecretEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) {
    // Keep the work profile roughly constant by doing *some* constant-time
    // comparison before the length-based reject.
    //
    // Use a fresh zero-filled Buffer of the SERVER-side length, not the
    // input Buffer twice. Node's `timingSafeEqual` is a thin wrapper over
    // OpenSSL `CRYPTO_memcmp` which already runs in constant time
    // independent of pointer identity — but compiling against the same
    // Buffer in both arguments makes a future micro-optimization (or a
    // non-OpenSSL crypto backend, e.g. an alternate Node fork) one
    // identity-check away from short-circuiting and reintroducing a
    // timing oracle. Comparing two distinct Buffers closes that risk
    // without changing the documented work-profile property.
    const dummy = Buffer.alloc(aBuf.length);
    timingSafeEqual(aBuf, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Headless Stripe payments core.
 *
 * Lives server-side. Holds the Stripe secret key via the injected
 * IStripeProvider, owns PaymentIntent / SetupIntent creation, runs registered
 * webhook handlers after signature verification, and tracks the observable
 * status a Shell subscribes to over the wcBindable wire.
 *
 * The card payload never crosses this Core — the browser hands card data
 * directly to Stripe through the Elements iframe (see SPEC §2 data plane
 * bypass). Only intent metadata, the client secret (never observable), and
 * confirmation outcomes flow through the WebSocket.
 *
 * Secret handling invariant (SPEC §9.2):
 *   - STRIPE_SECRET_KEY lives only inside the provider instance.
 *   - webhook signing secret lives only inside this Core.
 *   - clientSecret is stored per active intent in `_activeIntent` and never
 *     surfaced through an observable property or getter. The Shell receives
 *     it through the `requestIntent` RPC return value alone.
 */
export class StripeCore extends EventTarget {
  // Stripe error taxonomy constants are now hoisted to
  // `internal/errorTaxonomy.ts` so the Core's wire-side allowlist and
  // the Shell's purely-local allowlist (`Stripe._setErrorStateFromUnknown`)
  // cannot drift. Keep these aliases as `private static` so the existing
  // call sites (`StripeCore._STRIPE_TAXONOMY_TOKEN_RE.test(...)`) compile
  // unchanged, while the source of truth lives in one module.
  private static readonly _STRIPE_TAXONOMY_TOKEN_RE = STRIPE_TAXONOMY_TOKEN_RE;
  private static readonly _STRIPE_ERROR_CODE_RE = STRIPE_ERROR_CODE_RE;
  private static readonly _STRIPE_CLASS_NAME_RE = STRIPE_CLASS_NAME_RE;
  private static readonly _STRIPE_KNOWN_TYPES = STRIPE_KNOWN_TYPES;
  private static readonly _MAX_ERROR_MESSAGE_LENGTH: number = MAX_ERROR_MESSAGE_LENGTH;
  // Re-exposed from `./wcBindable.ts` so existing `StripeCore.wcBindable`
  // references keep compiling; the Shell's module graph imports from the
  // dedicated wcBindable module directly to avoid dragging `node:crypto`
  // into the browser bundle (see wcBindable.ts docstring).
  static wcBindable: IWcBindable = STRIPE_CORE_WC_BINDABLE;

  private _target: EventTarget;
  private _provider: IStripeProvider;
  /**
   * Webhook signing secret, retained for the lifetime of this Core so
   * `handleWebhook` can pass it to `_provider.verifyWebhook`. Cleared in
   * `dispose()` (SPEC §9.2 dispose-residue invariant).
   *
   * Kept as a `string` because `stripe-node`'s `webhooks.constructEvent`
   * accepts a string secret directly; a `Buffer`-backed alternative
   * (`buf.toString` immediately before each call) would shave one V8 string-
   * intern footprint at the cost of complicating the provider seam, and the
   * dedup-window allocation already dominates the per-Core memory profile.
   * Multi-tenant servers that build a Core per tenant SHOULD call
   * `dispose()` when the tenant is removed so the secret is not retained
   * once the tenant is gone — this is the contractually documented path.
   */
  private _webhookSecret: string | null;
  private _userContext: UserContext | undefined;
  private _cancelSetupIntents: boolean;
  private _webhookDedupCapacity: number;

  private _mode: StripeMode = "payment";
  private _amountValueHint: number | null = null;
  private _amountCurrencyHint: string | null = null;
  private _customerId: string | null = null;

  private _status: StripeStatus = "idle";
  private _loading: boolean = false;
  private _amount: StripeAmount | null = null;
  private _paymentMethod: StripePaymentMethod | null = null;
  private _intentId: string | null = null;
  private _error: StripeError | null = null;
  private _disposed: boolean = false;

  private _intentBuilder: IntentBuilder | null = null;
  private _webhookHandlers: Map<string, { handler: WebhookHandler; fatal: boolean }[]> = new Map();
  private _resumeAuthorizer: ResumeAuthorizer | null = null;
  /**
   * Dedup window for incoming webhook event IDs. Stripe's at-least-once
   * delivery can redeliver the same `event.id` (transient retries, 5xx
   * backoff, occasional retry-queue overlap).
   *
   * This is BEST-EFFORT and process-local only. Durable dedup belongs in
   * app handlers keyed by `event.id` + DB uniqueness constraints.
   *
   * Default 1024 is sized for typical single-tenant deployments. High-
   * throughput environments should pass `webhookDedupCapacity` through
   * the constructor so the eviction window covers the actual retry
   * storm Stripe may send.
   */
  private static readonly _DEFAULT_WEBHOOK_DEDUP_CAPACITY: number = 1024;
  private static readonly _MAX_WEBHOOK_DEDUP_CAPACITY: number = 1_000_000;
  /**
   * Backing store for the dedup window.
   *
   * `Map` is used instead of a `Set` + `Array` pair because:
   * - insertion order is preserved (ES2015 spec), so the "oldest" id is
   *   the first key returned by `keys().next()`,
   * - eviction is O(1) (`keys().next().value` + `delete`),
   * - membership tests stay O(1) via `has`,
   * - removing a specific id on fatal-handler re-throw is O(1) via
   *   `delete`, not O(n) as the old `indexOf` + `splice` pair was.
   *
   * The old Set+Array pair scaled as O(n) on both eviction (`shift`)
   * and fatal-throw cleanup (`indexOf` + `splice`), which became a
   * real cost at `_MAX_WEBHOOK_DEDUP_CAPACITY = 1_000_000`.
   * The Map shape is drop-in replacement for both lookups and bounded
   * retention while eliminating the linear scans.
   *
   * Value is `true` as a sentinel — we only care about keys. A `Set`
   * alone would do for membership but would require a second structure
   * for ordered eviction, reintroducing the O(n) path we are replacing.
   */
  private _seenWebhookIds: Map<string, true> = new Map();

  /**
   * Tracks the id, mode, and generation of the currently-active intent.
   *
   * Note: the Stripe-issued `clientSecret` is deliberately NOT stored here
   * (SPEC §5.2) — it is handed to the Shell exactly once as the return
   * value of `requestIntent` and never kept on the Core side. Surfacing it
   * through `this._intentId`'s event or a `_setClientSecret` helper would
   * broadcast a confirmation token to every subscriber and (via
   * RemoteShellProxy) every connected browser tab. This slot's only job on
   * the Core side is to let `cancelIntent` validate the id being cancelled
   * matches the one we created, and let fold paths scope state mutations
   * to the right intent/generation.
   *
   * `generation` increments on every `requestIntent` so that confirmation
   * reports or webhook-driven status transitions from a superseded intent
   * (user clicked submit twice, Stripe delivered the 3DS callback late) do
   * not clobber the current intent's state.
   */
  private _activeIntent: {
    id: string;
    mode: StripeMode;
    generation: number;
  } | null = null;
  private _generation: number = 0;

  constructor(
    provider: IStripeProvider,
    opts: {
      webhookSecret?: string;
      userContext?: UserContext;
      target?: EventTarget;
      cancelSetupIntents?: boolean;
      webhookDedupCapacity?: number;
    } = {},
  ) {
    super();
    // Loose type-check beyond the TS signature: callers reaching here from
    // JS or via an `as unknown as IStripeProvider` cast can still slip a
    // primitive (`""`, `0`, `null`) past the compiler. The truthiness gate
    // alone admits typeof-"function" — which is callable but lacks every
    // method we actually use — so reject anything that is not an object.
    if (!provider || typeof provider !== "object") {
      raiseError("provider is required and must be an object implementing IStripeProvider.");
    }
    this._provider = provider;
    // Loose type-check on the webhook secret too — same reasoning as the
    // provider check above. The TS `webhookSecret?: string` signature is
    // bypassed by `new StripeCore(p, { webhookSecret: 0 as any })` and
    // similar shapes; without an explicit gate, a number / null /
    // false-y non-string would either land on `this._webhookSecret` as-
    // is (and produce confusing diagnostics inside `handleWebhook`'s
    // "constructed without webhookSecret" branch, which assumes
    // string-or-null) or — worse — pass into the provider's
    // `constructEvent(rawBody, sig, secret)` and be coerced to "0"
    // before HMAC, silently weakening signature verification. Reject
    // explicitly. The empty string is also rejected because no
    // legitimate Stripe webhook signing secret is the empty string
    // ("whsec_..." has a non-zero suffix) and accepting it would make
    // `handleWebhook` mis-diagnose the failure as "constructed without
    // webhookSecret" instead of "configured with an empty string."
    if (opts.webhookSecret !== undefined) {
      if (typeof opts.webhookSecret !== "string") {
        raiseError("webhookSecret must be a string when provided.");
      }
      if (opts.webhookSecret === "") {
        raiseError("webhookSecret must be a non-empty string. Omit the option entirely if webhooks are not used.");
      }
    }
    this._webhookSecret = opts.webhookSecret ?? null;
    this._userContext = opts.userContext;
    this._target = opts.target ?? this;
    this._cancelSetupIntents = opts.cancelSetupIntents === true;
    if (opts.webhookDedupCapacity !== undefined) {
      // Upper bound guards against config typos (e.g. `1e10`) turning the
      // dedup Set into a gradual memory leak. 1_000_000 is orders of
      // magnitude above any legitimate Stripe retry storm for a single
      // process; anyone needing more should use a durable dedup layer
      // (DB uniqueness on event.id) rather than inflate this window.
      if (
        !Number.isInteger(opts.webhookDedupCapacity)
        || opts.webhookDedupCapacity < 1
        || opts.webhookDedupCapacity > StripeCore._MAX_WEBHOOK_DEDUP_CAPACITY
      ) {
        raiseError(
          `webhookDedupCapacity must be an integer in [1, ${StripeCore._MAX_WEBHOOK_DEDUP_CAPACITY}], got ${opts.webhookDedupCapacity}.`,
        );
      }
      this._webhookDedupCapacity = opts.webhookDedupCapacity;
    } else {
      this._webhookDedupCapacity = StripeCore._DEFAULT_WEBHOOK_DEDUP_CAPACITY;
    }
  }

  // --- Inputs ---

  get mode(): StripeMode { return this._mode; }
  set mode(value: StripeMode) {
    // Silently ignore writes after dispose so a late-firing setter from
    // a framework's controlled-prop reaction (React StrictMode unmount,
    // Vue tear-down) does not throw on a disposed Core. Symmetric with
    // dispose's "command paths raiseError; observers / setters no-op"
    // resilience contract.
    if (this._disposed) return;
    if (value !== "payment" && value !== "setup") {
      // Route through `summarizeUntrustedValue` (shared with the other
      // command input validators) so a megabyte-sized object pasted in
      // by a tampered wire payload cannot inflate the rejection message
      // into a megabyte-sized log / wire frame. TS narrows `value` to
      // `never` here (the union is exhausted), so cast through `unknown`
      // to recover discriminable shapes for the diagnostic.
      raiseError(`mode must be "payment" or "setup", got ${summarizeUntrustedValue(value as unknown)}.`);
    }
    this._mode = value;
  }

  get amountValue(): number | null { return this._amountValueHint; }
  /**
   * Stripe expects amount in the smallest currency unit (cents for USD,
   * yen for JPY, …) as an INTEGER. This setter accepts non-integer
   * values without rejecting them, because the canonical source of
   * truth is the server-side IntentBuilder (CLAUDE.md "The server
   * decides the amount.") — a hint value passed in here is advisory
   * and the builder may discard, round, or replace it anyway. A
   * fractional value will hit the `Number.isInteger` check inside
   * `StripeSdkProvider.createPaymentIntent` if it survives the
   * builder, producing a clear `[@csbc-dev/stripe]`-prefixed
   * diagnostic at the provider boundary. We deliberately do NOT
   * mirror that check here so apps that pass `amountValue` through
   * intermediate currency-conversion math (e.g. `Math.round` happens
   * inside the IntentBuilder) are not forced into a redundant
   * pre-round step.
   */
  set amountValue(value: number | null) {
    if (this._disposed) return;
    if (value === null || value === undefined) {
      this._amountValueHint = null;
      return;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) raiseError(`amountValue must be a non-negative number, got ${value}.`);
    this._amountValueHint = n;
  }

  get amountCurrency(): string | null { return this._amountCurrencyHint; }
  set amountCurrency(value: string | null) {
    if (this._disposed) return;
    // `null` / `undefined` / `""` all collapse to null — the empty string
    // never carries a useful Stripe-currency code, and the Shell's
    // `attributeChangedCallback` already maps `amount-currency=""` →
    // `null` via the `newValue || null` shape. Keeping the Core's setter
    // aligned with that shape preserves Shell-vs-direct-property symmetry.
    if (value === null || value === undefined || value === "") {
      this._amountCurrencyHint = null;
      return;
    }
    this._amountCurrencyHint = String(value);
  }

  get customerId(): string | null { return this._customerId; }
  set customerId(value: string | null) {
    if (this._disposed) return;
    // Same shape as amountCurrency: `""` is treated as "clear", matching
    // the Shell's `customer-id=""` → null mapping in attributeChangedCallback.
    if (value === null || value === undefined || value === "") {
      this._customerId = null;
      return;
    }
    this._customerId = String(value);
  }

  // --- Output state ---

  get status(): StripeStatus { return this._status; }
  get loading(): boolean { return this._loading; }
  get amount(): StripeAmount | null {
    return this._amount ? { ...this._amount } : null;
  }
  get paymentMethod(): StripePaymentMethod | null {
    return this._paymentMethod ? { ...this._paymentMethod } : null;
  }
  get intentId(): string | null { return this._intentId; }
  get error(): StripeError | null {
    // Defensive shallow copy on the read side, symmetric with `get
    // amount()` / `get paymentMethod()`. The storage side
    // (`_setError`) already copies on the way in, so this is the
    // matching half of the contract — a consumer cannot poison
    // `_error` by mutating the returned object in place
    // (`el.error.message = "X"`). Without this copy, the `_error`
    // slot's defense against caller-side mutation only covered the
    // write path.
    return this._error ? { ...this._error } : null;
  }

  // --- Registration API (server-side only) ---

  /**
   * Register the server-side builder that decides amount/currency/customer
   * for incoming intent requests. REQUIRED — `requestIntent` rejects with an
   * `intent_builder_not_registered` error until this is set (SPEC §6.3).
   *
   * This is the single point that converts a tamperable Shell hint into the
   * server's authoritative intent options. Typical usage pulls amount from
   * the cart/order DB keyed by the authenticated UserContext, never from
   * `request.hint.amountValue` directly.
   *
   * Calling twice replaces the prior builder; returns a disposer for the
   * registration. Unlike registerWebhookHandler (which supports multiple
   * handlers per event type), there is only ever one active builder because
   * amount/currency must have a single source of truth.
   *
   * Disposer semantics: the returned function unregisters ONLY the
   * builder it was paired with. If a later `registerIntentBuilder(next)`
   * call replaced this one, the old disposer silently becomes a no-op —
   * it cannot retroactively unregister `next`. This keeps a late-fired
   * cleanup (React StrictMode double-invoke, effect ordering) from
   * clobbering the currently-active builder. Symmetric with
   * `registerResumeAuthorizer`.
   */
  registerIntentBuilder(builder: IntentBuilder): () => void {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    if (typeof builder !== "function") raiseError("builder must be a function.");
    this._intentBuilder = builder;
    return () => {
      if (this._intentBuilder === builder) this._intentBuilder = null;
    };
  }

  /**
   * Register a webhook handler for a Stripe event type (e.g.
   * `"payment_intent.succeeded"`). Multiple handlers per type are allowed
   * and run in registration order.
   *
   * Idempotency requirement: this Core keeps a best-effort in-memory dedup
   * window (sized by `webhookDedupCapacity` constructor option; default
   * 1024 recent `event.id` values) and short-circuits
   * duplicate delivery with success semantics. This suppresses rapid retry
   * storms on a single process, but it is NOT durability:
   * - multi-process deployments each have their own window,
   * - process restarts lose the window,
   * - fatal handler throws evict the id so Stripe retries can re-deliver.
   *
   * Handlers that write to external systems (fulfillment DB, email, stock
   * debit) MUST still be idempotent — typically keyed by `event.id` against
   * a uniqueness constraint in the authoritative store.
   *
   * `options.fatal` (default `true`): a fatal handler's throw propagates out
   * of `handleWebhook`, so the app's HTTP route returns 5xx and Stripe
   * retries per its delivery policy — the canonical behavior for handlers
   * that gate DB writes (fulfillment, provisioning, refund). `fatal: false`
   * is for ancillary handlers (audit log, notification, telemetry): a throw
   * emits `stripe-checkout:webhook-warning` on the Core's target and the chain
   * continues. Mirrors s3-uploader's registerPostProcess semantics.
   */
  registerWebhookHandler(
    type: string,
    handler: WebhookHandler,
    options: WebhookRegisterOptions = {},
  ): () => void {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    if (!type || typeof type !== "string") raiseError("type must be a non-empty string.");
    if (typeof handler !== "function") raiseError("handler must be a function.");
    const entry = { handler, fatal: options.fatal !== false };
    const list = this._webhookHandlers.get(type) ?? [];
    list.push(entry);
    this._webhookHandlers.set(type, list);
    return () => {
      const current = this._webhookHandlers.get(type);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) this._webhookHandlers.delete(type);
    };
  }

  /**
   * Optional defense-in-depth hook for `resumeIntent`. Runs AFTER the
   * built-in clientSecret check (which is always applied) and BEFORE
   * `_activeIntent` is rebuilt. Returning `false` rejects the resume with
   * a `resume_not_authorized` error.
   *
   * The clientSecret check is Stripe's native authorization model and is
   * on by default — registering an authorizer is for apps that want an
   * additional per-user / per-tenant check on top (e.g. "the intent's
   * `metadata.userId` must equal the authenticated `ctx.sub`").
   *
   * Calling twice replaces the prior authorizer; returns a disposer.
   *
   * Disposer semantics: the returned function unregisters ONLY the
   * authorizer it was paired with. If a later `registerResumeAuthorizer(
   * next)` call replaced this one, the old disposer silently becomes a
   * no-op — it cannot retroactively unregister `next`. Symmetric with
   * `registerIntentBuilder`.
   */
  registerResumeAuthorizer(authorizer: ResumeAuthorizer): () => void {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    if (typeof authorizer !== "function") raiseError("authorizer must be a function.");
    this._resumeAuthorizer = authorizer;
    return () => {
      if (this._resumeAuthorizer === authorizer) this._resumeAuthorizer = null;
    };
  }

  /**
   * @internal
   * Read the current EventTarget. Used by the Shell's
   * `attachLocalCore` to snapshot the pre-attach target so
   * `disconnectedCallback` can restore it (the prior shape always
   * restored to `core` itself, which was wrong for Cores that were
   * constructed with an explicit `target: customEventTarget` option).
   *
   * Reads only — no side effects. Returns the Core itself (the default
   * from the constructor when no `target` was supplied) when the Core
   * was constructed standalone. Application code should NOT call this;
   * the seam exists only for the Shell's lifecycle bookkeeping.
   * Public API stability is not guaranteed.
   */
  _getEventTarget(): EventTarget {
    return this._target;
  }

  /**
   * @internal
   * Swap the EventTarget that subsequent `_setStatus` / `_setLoading` /
   * `_setAmount` / `_setPaymentMethod` / `_setIntentId` / `_setError`
   * dispatches fire on. Used by the Shell's `attachLocalCore` /
   * `disconnectedCallback` to rewire the Core's dispatch target between
   * the Shell DOM node (so observable events bubble up the DOM and
   * `el.addEventListener("stripe-checkout:status-changed", ...)` fires)
   * and the Core itself (so a detached Shell can be GC'd without a
   * Core-held reference keeping it alive).
   *
   * Marked @internal because it bypasses the constructor's `target`
   * injection — the Core's whole reason to accept a target is so the
   * Shell can inject `this` once at construction; this setter is only
   * needed when the Shell takes ownership of a Core that was constructed
   * standalone (e.g. by a test) and now must re-route its events to the
   * Shell's DOM node mid-lifecycle. Application code should NOT call this.
   * Public API stability is not guaranteed.
   */
  _setEventTarget(target: EventTarget): void {
    // Silently no-op after dispose, matching the resilience contract used
    // by every public input setter (`set mode`, `set amountValue`, …):
    // "command paths raiseError; observers / setters no-op." A late call
    // from a framework's tear-down (React StrictMode double-invoke, Vue
    // unmount) or from the Shell's `disconnectedCallback` (which always
    // restores the target to the pre-attach value on detach) must not
    // throw — a throw inside `disconnectedCallback` propagates into the
    // browser's mutation-observer machinery and corrupts the parent's
    // detach sequence. Returning early also lets the Shell call this
    // without first probing `core._disposed` through a cast, which was
    // the reviewer's actual concern: a private-field bypass was
    // reintroduced by the guard's previous raise-on-disposed shape.
    if (this._disposed) return;
    if (!target) raiseError("target must be a non-null EventTarget.");
    this._target = target;
  }

  // --- Setters / dispatch ---

  private _setStatus(v: StripeStatus): void {
    if (this._status === v) return;
    this._status = v;
    this._target.dispatchEvent(new CustomEvent("stripe-checkout:status-changed", { detail: v, bubbles: true }));
  }

  private _setLoading(v: boolean): void {
    if (this._loading === v) return;
    this._loading = v;
    this._target.dispatchEvent(new CustomEvent("stripe-checkout:loading-changed", { detail: v, bubbles: true }));
  }

  private _setAmount(a: StripeAmount | null): void {
    const prev = this._amount;
    if (prev === a) return;
    if (prev && a && prev.value === a.value && prev.currency === a.currency) return;
    // Store a defensive shallow copy so a caller that retains the original
    // reference (provider-returned object, IntentBuilder-produced struct)
    // and mutates it AFTER this set cannot retroactively change observable
    // state, the dedup baseline (`prev.value === a.value`), or future
    // event details. The getter (`get amount()`) and the dispatched event
    // detail already return / forward copies; this closes the same gate
    // on the storage side.
    this._amount = a ? { ...a } : null;
    this._target.dispatchEvent(new CustomEvent("stripe-checkout:amount-changed", { detail: a ? { ...a } : null, bubbles: true }));
  }

  private _setPaymentMethod(pm: StripePaymentMethod | null): void {
    const prev = this._paymentMethod;
    if (prev === pm) return;
    if (prev && pm && prev.id === pm.id && prev.brand === pm.brand && prev.last4 === pm.last4) return;
    // Same defensive-copy rationale as `_setAmount`.
    this._paymentMethod = pm ? { ...pm } : null;
    this._target.dispatchEvent(new CustomEvent("stripe-checkout:paymentMethod-changed", { detail: pm ? { ...pm } : null, bubbles: true }));
  }

  private _setIntentId(id: string | null): void {
    if (this._intentId === id) return;
    this._intentId = id;
    this._target.dispatchEvent(new CustomEvent("stripe-checkout:intentId-changed", { detail: id, bubbles: true }));
  }

  private _setError(err: StripeError | null): void {
    const prev = this._error;
    if (prev === err) return;
    // Field-by-field equality over the fixed `StripeError` shape. The
    // earlier `Object.keys` + Set construction allocated a fresh Set per
    // call to detect "same-length-different-keys" shape mismatches, but
    // `StripeError` is closed at four fields (`code` / `declineCode` /
    // `type` / `message`) so a hand-rolled check is both faster (no Set
    // allocation, no key-iteration order quirks) and easier to audit.
    // Mirrors the Shell-side `_errorShapeEquals` helper.
    //
    // A field that is present on one side and absent on the other
    // produces `undefined !== "x"` on one comparison, so the shape
    // mismatch still triggers a re-dispatch — same outcome as the
    // previous Set-based path. If a future `StripeError` adds a field,
    // adding one more `&& a.X === b.X` here is a one-line change and
    // the missing-line is a visible compile-error candidate (any read
    // through `prev.NEW_FIELD` / `err.NEW_FIELD` on a typed StripeError
    // surfaces at this site).
    if (prev && err
      && prev.code === err.code
      && prev.declineCode === err.declineCode
      && prev.type === err.type
      && prev.message === err.message
    ) return;
    // Defensive shallow copy on the storage side, symmetric with
    // `_setAmount` / `_setPaymentMethod`. Without it, a caller that
    // retains the original `err` reference (sanitized object from
    // `_sanitizeError`, IntentBuilder-produced struct, raw view from a
    // custom provider) and mutates it AFTER this set could
    // retroactively change observable state, the dedup baseline above,
    // and the dispatched event detail. The getter (`get error()`)
    // already returns the stored reference verbatim; freezing the
    // input shape on entry closes the same gate at the dispatch side
    // too — the event's `detail` is a copy so a downstream listener
    // mutating it cannot poison the in-memory `_error` slot either.
    this._error = err ? { ...err } : null;
    this._target.dispatchEvent(new CustomEvent("stripe-checkout:error", {
      detail: err ? { ...err } : null,
      bubbles: true,
    }));
  }

  /**
   * Turn anything throwable into a sanitized StripeError. Raw stripe-node
   * errors carry internals (request IDs, stack traces, the HTTP body Stripe
   * returned) that must not cross the WebSocket unredacted — SPEC §9.3.
   *
   * Message-copy policy: the `message` field is only forwarded when the
   * error looks like (a) a Stripe SDK error — `type` matches the tight
   * class-name regex `_STRIPE_CLASS_NAME_RE` (StripeCardError,
   * StripeAPIError, …) or is one of the known Stripe API object tokens
   * in `_STRIPE_KNOWN_TYPES` (card_error, invalid_request_error,
   * api_error, …) — or (b) one of our own
   * `[@csbc-dev/stripe]`-prefixed internal errors whose messages
   * are hand-curated. Anything else
   * (IntentBuilder throwing a raw `new Error("DB auth failed for user=...")`,
   * a network-layer exception whose `.message` contains internal hostnames,
   * etc.) is replaced with a generic "Payment failed." so the observable
   * `error` property and the wire-serialized throw do not leak server-side
  * details to the browser. `code` / `decline_code` / `type` are copied
  * only when they pass a strict Stripe-taxonomy token allowlist.
   *
   * Note: this sanitizer does NOT HTML-sanitize `message`; it only controls
   * shape and what sources are allowed to provide raw message text. Shell/UI
   * renderers must treat error text as plain text (not trusted HTML).
   */
  private _sanitizeError(err: unknown): StripeError {
    const sanitizeToken = (
      value: unknown,
      allowedPattern: RegExp = StripeCore._STRIPE_TAXONOMY_TOKEN_RE,
    ): string | undefined => {
      if (typeof value !== "string") return undefined;
      return allowedPattern.test(value) ? value : undefined;
    };
    // Cap message length to prevent pathological throws from flooding the
    // wire / DOM / log sinks. Truncation preserves the shape (`StripeError`
    // .message is always a string) while trading prefix visibility for
    // bounded cost. Ellipsis makes the truncation visible at the UI level
    // so operators notice an oversized message.
    const truncateMessage = (msg: string): string => {
      if (msg.length <= StripeCore._MAX_ERROR_MESSAGE_LENGTH) return msg;
      // Reserve 1 char for the ellipsis so the final string length equals
      // `_MAX_ERROR_MESSAGE_LENGTH`.
      return msg.slice(0, StripeCore._MAX_ERROR_MESSAGE_LENGTH - 1) + "…";
    };

    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      // `type` comes in one of two shapes:
      //   - Stripe API object token: `card_error`, `invalid_request_error`, …
      //     (all lowercase; validated by `_STRIPE_TAXONOMY_TOKEN_RE`).
      //   - Stripe SDK class name: `StripeCardError`, `StripeAPIError`, …
      //     (PascalCase + Error suffix; validated by `_STRIPE_CLASS_NAME_RE`).
      // Accept either explicitly so tightening the taxonomy regex to
      // lowercase-only (no `/i` flag) does not reject legitimate class-name
      // forms.
      const rawType = typeof e.type === "string" ? e.type : undefined;
      const type = rawType !== undefined
        && (StripeCore._STRIPE_TAXONOMY_TOKEN_RE.test(rawType)
          || StripeCore._STRIPE_CLASS_NAME_RE.test(rawType))
        ? rawType
        : undefined;
      const rawMessage = typeof e.message === "string" ? e.message : undefined;
      const stripeShaped = type !== undefined
        && (StripeCore._STRIPE_CLASS_NAME_RE.test(type) || StripeCore._STRIPE_KNOWN_TYPES.has(type));
      const internal = rawMessage !== undefined
        && rawMessage.startsWith("[@csbc-dev/stripe]");
      const safeMessage = (stripeShaped || internal) && rawMessage !== undefined
        ? rawMessage
        : "Payment failed.";
      return {
        code: sanitizeToken(e.code, StripeCore._STRIPE_ERROR_CODE_RE),
        declineCode: sanitizeToken(e.decline_code, StripeCore._STRIPE_ERROR_CODE_RE)
          ?? sanitizeToken(e.declineCode, StripeCore._STRIPE_ERROR_CODE_RE),
        type,
        message: truncateMessage(safeMessage),
      };
    }
    return { message: "Payment failed." };
  }

  // --- Commands ---

  /**
   * Create a PaymentIntent or SetupIntent for the Shell to confirm against.
   * Flow:
   *   1. Enforce the IntentBuilder is registered (fail-loud per SPEC §6.3).
   *   2. Invoke the builder with the client hint + UserContext so the app
   *      decides the final amount/currency/customer.
   *   3. Call the provider to actually create the intent at Stripe.
   *   4. Stash the active-intent snapshot, bump the generation counter, and
   *      return `{ intentId, clientSecret, ... }` to the Shell.
   *
   * `status` advances `idle → processing` during the provider call and
   * lands on `collecting` after success so the Shell knows Elements should
   * mount. A failure here surfaces through `_error` and returns status to
   * `idle`.
   */
  async requestIntent(request: IntentRequest): Promise<IntentCreationResult> {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    if (!request || typeof request !== "object") raiseError("request is required.");
    const mode = request.mode ?? this._mode;
    if (mode !== "payment" && mode !== "setup") {
      raiseError(`mode must be "payment" or "setup", got ${summarizeUntrustedValue(mode)}.`);
    }
    // Shape-validate the hint BEFORE forwarding to the IntentBuilder.
    // Hints arrive from RemoteCoreProxy verbatim (the browser Shell is
    // tamperable), and while the IntentBuilder is the source of truth for
    // amount / currency / customer, the builder's own code may downstream-
    // cast fields (`hint.amountValue > threshold`, `cart.lookup(hint.
    // customerId)`) without guarding shape. A malformed value like
    // `amountValue: { $gt: 0 }` would coerce or explode in surprising
    // ways; rejecting obviously-invalid shapes here keeps the builder
    // contract clean. Unknown / wrong-type fields are dropped to
    // undefined so the builder sees a normalized `IntentRequestHint`.
    //
    // Note: these shape checks run BEFORE any observable-state transition
    // (no `_setStatus("processing")` / `_setLoading(true)` has fired yet),
    // so we don't need to mirror the rollback pattern used by the
    // `intent_builder_not_registered` branch below. `raiseError` simply
    // throws and the caller observes state unchanged from its pre-call
    // value. If a future refactor moves a state transition above this
    // block, add `_setError` / `_setStatus("idle")` / `_setLoading(false)`
    // before each `raiseError` here to preserve the
    // "every error path lands on idle / loading=false" invariant.
    if (request.hint !== undefined && (typeof request.hint !== "object" || request.hint === null)) {
      raiseError(`request.hint must be an object or undefined, got ${summarizeUntrustedValue(request.hint)}.`);
    }
    const rawHint = request.hint as Record<string, unknown> | undefined;
    if (rawHint !== undefined) {
      if (rawHint.amountValue !== undefined) {
        if (typeof rawHint.amountValue !== "number"
          || !Number.isFinite(rawHint.amountValue)
          || rawHint.amountValue < 0
        ) {
          raiseError(`request.hint.amountValue must be a non-negative finite number, got ${summarizeUntrustedValue(rawHint.amountValue)}.`);
        }
      }
      if (rawHint.amountCurrency !== undefined && typeof rawHint.amountCurrency !== "string") {
        raiseError(`request.hint.amountCurrency must be a string, got ${summarizeUntrustedValue(rawHint.amountCurrency)}.`);
      }
      if (rawHint.customerId !== undefined && typeof rawHint.customerId !== "string") {
        raiseError(`request.hint.customerId must be a string, got ${summarizeUntrustedValue(rawHint.customerId)}.`);
      }
    }
    if (!this._intentBuilder) {
      const err: StripeError = {
        code: "intent_builder_not_registered",
        message: "StripeCore.registerIntentBuilder() must be called before requestIntent.",
      };
      // Preserve the "every error path lands on idle / loading=false"
      // invariant that downstream error branches already honor. A caller
      // that reached this with status=collecting from a prior session
      // would otherwise stay wedged on a stale status after the throw.
      this._setError(err);
      this._setStatus("idle");
      this._setLoading(false);
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    this._generation++;
    const gen = this._generation;
    this._setError(null);
    this._setLoading(true);
    this._setStatus("processing");
    this._setPaymentMethod(null);

    // Build a normalized hint with ONLY the three known fields.
    // `IntentRequestHint` is a closed shape at the TYPE level (no index
    // signature — see `src/types.ts`), but the wire surface
    // (RemoteCoreProxy) accepts whatever JSON the Shell sends and a
    // tampered payload could carry extra keys like `__proto__` /
    // `constructor` / `toString` that some builder implementations
    // would inadvertently spread into Stripe options (`{ ...hint,
    // currency: "usd" }`), polluting the create-intent payload.
    // The closed-shape type catches this at compile time on the Core
    // side, but the runtime gate below is the defense-in-depth for
    // wire-untrusted inputs: extra keys are silently dropped here, and
    // the IntentBuilder only ever sees a normalized object with
    // exactly the three named, shape-validated fields.
    // Per-field merge: a present-but-empty `hint` (`{}` from a Shell
    // that called `requestIntent({ mode: "payment", hint: {} })`)
    // should still pick up the Core's instance-level
    // `set amountValue` / `set amountCurrency` / `set customerId`
    // writes — the earlier object-replacement shape silently dropped
    // every instance default whenever the caller passed any hint at
    // all, which surprised API users who set inputs on the Core
    // directly and then called `requestIntent` without rebuilding
    // them into the hint payload. Each hint field is forwarded only
    // when it is the documented type; otherwise the instance default
    // fills in. The IntentBuilder still observes a normalized
    // `IntentRequestHint` with exactly the three named keys.
    const sourceHint = request.hint as Record<string, unknown> | undefined;
    const hint: IntentRequestHint = {
      amountValue: sourceHint && typeof sourceHint.amountValue === "number"
        ? sourceHint.amountValue
        : (this._amountValueHint ?? undefined),
      amountCurrency: sourceHint && typeof sourceHint.amountCurrency === "string"
        ? sourceHint.amountCurrency
        : (this._amountCurrencyHint ?? undefined),
      customerId: sourceHint && typeof sourceHint.customerId === "string"
        ? sourceHint.customerId
        : (this._customerId ?? undefined),
    };

    let built: IntentBuilderResult;
    try {
      built = await this._intentBuilder({ mode, hint }, this._userContext);
    } catch (e: unknown) {
      // Sanitize the throw too — not just the observable `_error`. The
      // RemoteShellProxy serializes thrown `Error` instances by their
      // raw `message` (and name/stack), so a `throw e` would put the
      // un-allowlisted IntentBuilder error message onto the wire even
      // though `_setError` upstairs already replaced it with the sanitized
      // shape on the observable state. Mirrors the `mode_mismatch` /
      // `intent_builder_not_registered` branches below, which already
      // assemble a sanitized `Error` for the throw.
      const sanitized = this._sanitizeError(e);
      if (gen === this._generation) {
        this._setError(sanitized);
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw Object.assign(new Error(sanitized.message), sanitized.code ? { code: sanitized.code } : {});
    }

    // Validate the builder returned options matching the requested mode. A
    // cross-mode mismatch would route a PaymentIntent create through the
    // setup path (or vice versa) — a programming error we want to surface
    // loudly rather than silently charging the wrong surface.
    if (built.mode !== mode) {
      const err: StripeError = {
        code: "intent_builder_mode_mismatch",
        message: `IntentBuilder returned mode "${built.mode}" but client requested "${mode}".`,
      };
      if (gen === this._generation) {
        this._setError(err);
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    let creation: IntentCreationResult;
    try {
      if (built.mode === "payment") {
        const { mode: _m, ...options } = built;
        creation = await this._provider.createPaymentIntent(options as PaymentIntentOptions);
      } else {
        const { mode: _m, ...options } = built;
        creation = await this._provider.createSetupIntent(options as SetupIntentOptions);
      }
    } catch (e: unknown) {
      // Sanitize the throw before rethrow — same rationale as the
      // IntentBuilder catch above. Stripe SDK errors usually pass the
      // class-name / known-type allowlist so `message` is forwarded; a
      // non-Stripe-shaped error from a custom provider collapses to the
      // generic "Payment failed." per `_sanitizeError`.
      const sanitized = this._sanitizeError(e);
      if (gen === this._generation) {
        this._setError(sanitized);
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw Object.assign(new Error(sanitized.message), sanitized.code ? { code: sanitized.code } : {});
    }

    // Superseded mid-flight — user fired another requestIntent while this
    // one was at the provider. Best-effort cancel the orphan PaymentIntent
    // (Core deliberately skips SetupIntent cancel by default: stale rows
    // are harmless; PaymentIntents reserve the amount against the card's
    // available balance, so we free it). Apps that opted in to
    // `cancelSetupIntents: true` want the same cleanup for SetupIntents
    // (audit / dashboard hygiene) — honor that here too.
    if (gen !== this._generation) {
      // Use `mode` (the validated request mode) rather than `creation.mode`
      // here. Both are equal in practice (line 670 above already rejected a
      // builder/request mode mismatch), but routing the cleanup through the
      // same `mode` value used to pick the create-call branch keeps the
      // supersede cleanup symmetric with the create-call dispatch — a
      // future `IStripeProvider` that misreports `creation.mode` would
      // otherwise silently route the cancel to the wrong branch.
      if (mode === "payment") {
        this._provider.cancelPaymentIntent(creation.intentId).catch(() => { /* best-effort */ });
      } else if (this._cancelSetupIntents && this._provider.cancelSetupIntent) {
        this._provider.cancelSetupIntent(creation.intentId).catch(() => { /* best-effort */ });
      }
      throw new Error("[@csbc-dev/stripe] requestIntent superseded.");
    }

    this._activeIntent = { id: creation.intentId, mode, generation: gen };
    // Dispatch order: amount → intentId → status. A listener that
    // subscribes to `intentId-changed` and reads `el.amount` must see
    // the NEW amount, not the value from the prior intent. Swapping
    // this order was a subtle UX regression where "total" labels flashed
    // stale on new-intent transitions.
    //
    // amount is only meaningful in payment mode (SPEC §5.1). In setup mode
    // force it to null so a prior payment-mode amount does not bleed through
    // into a subsequent setup session on the same Core.
    this._setAmount(mode === "payment" && creation.amount ? creation.amount : null);
    this._setIntentId(creation.intentId);
    this._setStatus("collecting");
    this._setLoading(false);
    return creation;
  }

  /**
   * The Shell reports the outcome of `stripe.confirmPayment` / `confirmSetup`.
   * Status transitions follow SPEC §4:
   *   succeeded       → `status = "succeeded"`, paymentMethod populated
   *   processing      → `status = "processing"`, poll the provider to reach
   *                     a terminal state (webhook may be delayed / missing
   *                     in test environments)
   *   requires_action → `status = "requires_action"` (redirect imminent or
   *                     in progress)
   *   failed          → `status = "failed"`, error populated
   *
   * Stale reports (intentId does not match `_activeIntent.id` or the
   * generation has advanced) are dropped silently — the original intent
   * was already superseded and the current one is the source of truth.
   */
  async reportConfirmation(report: ConfirmationReport): Promise<void> {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    if (!report || typeof report !== "object") raiseError("report is required.");
    const active = this._activeIntent;
    if (!active) return; // no active intent — stale/late report, drop.
    if (active.id !== report.intentId) return;
    const gen = active.generation;

    switch (report.outcome) {
      case "succeeded": {
        // A prior failed attempt on the SAME intent (card_declined → retry
        // with another card → success) would otherwise leave the stale
        // `error` populated even as status flips to succeeded. Clear it
        // so the observable surface reflects the terminal truth.
        this._setError(null);
        // Shape-validate the reported paymentMethod before adopting it.
        // `report.paymentMethod` arrives over the wire from a tamperable
        // Shell; without this gate, a forged report could put attacker-
        // controlled strings onto the observable surface. A failed
        // validation collapses to "no report" and the server-side
        // retrieve fallback below picks up the real value from Stripe.
        const validated = report.paymentMethod ? validateReportedPaymentMethod(report.paymentMethod) : undefined;
        if (validated) {
          this._setPaymentMethod(validated);
        } else if (!this._paymentMethod) {
          // Stripe.js's `confirmPayment` result frequently returns
          // `payment_method` as a bare id string (not an expanded object),
          // so the Shell cannot populate brand/last4 from the client side
          // alone. Fall back to a server-side retrieve — the provider is
          // expected to expand `payment_method` so we get the card details
          // reliably. Best-effort: if the fetch fails, the webhook path can
          // still fill the slot later.
          try {
            const view = await this._provider.retrieveIntent(active.mode, active.id);
            if (gen !== this._generation) return; // superseded during fetch
            if (view.paymentMethod) this._setPaymentMethod(view.paymentMethod);
          } catch { /* keep pm null; webhook will reconcile later */ }
        }
        // Re-check generation: the retrieveIntent catch above swallows
        // the error silently, so a supersede that raced with the retrieve
        // await would otherwise fall through to `_setStatus("succeeded")`
        // and stamp a terminal state onto a superseded intent. The try's
        // inner guard only fires on success; this closes the throw path.
        if (gen !== this._generation) return;
        this._setStatus("succeeded");
        this._setLoading(false);
        return;
      }
      case "requires_action": {
        this._setStatus("requires_action");
        this._setLoading(false);
        return;
      }
      case "failed": {
        // Always populate `_error` on the failed terminal so observers see
        // a consistent surface. The succeeded branch above explicitly
        // clears `_error`; without this fallback, a failed report missing
        // `report.error` would leave a stale (or null) error alongside a
        // `failed` status, breaking the "every terminal carries diagnostic
        // shape consistent with status" invariant. The generic shape goes
        // through `_sanitizeError` so callers reading `error.message` get
        // the same `"Payment failed."` text the sanitizer produces on
        // unknown error sources.
        this._setError(report.error
          ? this._sanitizeError(report.error)
          : this._sanitizeError({}));
        this._setStatus("failed");
        this._setLoading(false);
        return;
      }
      case "processing": {
        this._setStatus("processing");
        this._setLoading(true);
        // Poll once now so a terminal state arriving before the webhook does
        // not get wedged. Best-effort: webhook path remains authoritative
        // for the actual DB writes via registered handlers.
        try {
          const view = await this._provider.retrieveIntent(active.mode, active.id);
          if (gen !== this._generation) return; // superseded during await
          this._reconcileFromIntentView(active.mode, view);
        } catch { /* ignore — webhook or next confirmation will resolve */ }
        return;
      }
      default: {
        // Compile-time exhaustiveness check: every union member must be
        // handled by the cases above. The runtime could still carry a
        // value outside the union (malformed cmd payload from a broken
        // client) — surface it in the error message to aid debugging.
        const exhaustive: never = report.outcome;
        raiseError(`unknown outcome: ${summarizeUntrustedValue(exhaustive as unknown)}.`);
      }
    }
  }

  /**
   * Fold a fresh intent view back into observable state. Used both by the
   * `processing` polling branch of reportConfirmation and by webhook
   * handlers that want to re-sync after a mutation.
   *
   * Stripe status strings are mapped to our StripeStatus union:
   *   succeeded                          → "succeeded"
   *   requires_capture                   → "succeeded" (manual-capture flow,
   *                                      user action complete)
   *   requires_action | requires_confirmation
   *                                      → "requires_action"
   *   requires_payment_method            → "failed"
   *   processing                         → "processing"
   *   canceled                           → "failed"
  *
  * Unknown Stripe statuses are intentionally left unchanged here (default
  * branch) so resolution stays webhook-authoritative. For observability,
  * Core dispatches `stripe-checkout:unknown-status` on its target with
  * `{ source: "core", intentId, mode, status }`. Applications should
  * subscribe and apply a timeout/escalation policy for webhook-less or
  * misconfigured webhook environments.
   */
  private _reconcileFromIntentView(mode: StripeMode, view: { status: string; amount?: StripeAmount; paymentMethod?: StripePaymentMethod; lastPaymentError?: StripeError }): void {
    if (view.paymentMethod) this._setPaymentMethod(view.paymentMethod);
    // amount is only meaningful in payment mode (SPEC §5.1). Reflect it
    // only for payment-mode views — if a custom provider returns amount on
    // a setup intent view, drop it rather than leak it through the bindable
    // surface. Symmetric with the amount-clear in `requestIntent`.
    if (mode === "payment") {
      if (view.amount) this._setAmount(view.amount);
    } else if (this._amount !== null) {
      this._setAmount(null);
    }
    switch (view.status) {
      case "succeeded":
        // Mirror the clear in reportConfirmation's direct succeeded
        // branch and the webhook succeeded fold — reach here through
        // the reportConfirmation-processing-poll or resumeIntent paths
        // with a terminal "succeeded" view, so any lingering error
        // from a prior failed attempt on the same intent must be
        // dropped. Without this, a fail-then-processing-then-succeeded
        // sequence ends with status=succeeded + error=card_declined.
        this._setError(null);
        this._setStatus("succeeded");
        this._setLoading(false);
        break;
      case "requires_action":
      case "requires_confirmation":
        this._setStatus("requires_action");
        this._setLoading(false);
        break;
      case "processing":
        this._setStatus("processing");
        break;
      case "requires_capture":
        // Manual-capture (`capture_method: "manual"`) flow: the charge is
        // authorized and held on the card, awaiting a server-side
        // `paymentIntents.capture()` call to finalize. From the browser
        // perspective the user has completed their part of the flow, so
        // map to `"succeeded"` — the user-facing UX ("payment complete")
        // is the same. Merchants needing finer granularity (authorized
        // vs captured) already observe Stripe's raw status via the
        // webhook handler and their DB, not via the observable surface.
        // Without this case the status would fall to the default branch,
        // the unknown-status event would fire, and the UI would stay on
        // whatever prior status was set (typically `processing`).
        this._setError(null);
        this._setStatus("succeeded");
        this._setLoading(false);
        break;
      case "requires_payment_method":
        // Sanitize even though `view.lastPaymentError` comes from the
        // provider's retrieve path and should already be shaped like a
        // clean Stripe error. A custom `IStripeProvider` (or a future
        // Stripe response change) could still produce a shape that the
        // allowlist would reject; routing through `_sanitizeError` keeps
        // wire-bound `message` / `code` under the same policy as every
        // other error sink on the Core.
        if (view.lastPaymentError) this._setError(this._sanitizeError(view.lastPaymentError));
        this._setStatus("failed");
        this._setLoading(false);
        break;
      case "canceled":
        // Stripe keeps `last_payment_error` / `last_setup_error` on the
        // canceled intent when cancellation followed a failed attempt
        // (declined card, authentication fail, etc). Surface it so UI
        // can show *why* — otherwise the caller only sees a silent
        // `failed`. Symmetric with requires_payment_method above.
        if (view.lastPaymentError) this._setError(this._sanitizeError(view.lastPaymentError));
        this._setStatus("failed");
        this._setLoading(false);
        break;
      default:
        this._target.dispatchEvent(new CustomEvent<UnknownStatusDetail>("stripe-checkout:unknown-status", {
          detail: {
            source: "core",
            intentId: this._intentId,
            mode,
            status: view.status,
          },
          bubbles: true,
        }));
      // leave status unchanged (unrecognized Stripe status string).
    }
  }

  /**
  * Cancel the active PaymentIntent. For SetupIntents, this Core defaults
  * to no Stripe API call (natural expiry / explicit reset semantics) and
  * transitions to `idle` locally. Apps can opt in to explicit
  * `setupIntents.cancel` by constructing StripeCore with
  * `{ cancelSetupIntents: true }` and providing `cancelSetupIntent` on the
  * provider.
   *
   * (Stripe DOES support `setupIntents.cancel` — skipping it here is a
   * cost optimization: SetupIntents carry no reserved balance, so a stale
   * `requires_payment_method` row in the Stripe dashboard is harmless and
   * not worth the extra network round-trip. Apps that want explicit
   * server-side cancel can implement it in their own `IStripeProvider`.)
   *
   * Bumps the generation so any in-flight confirmation report or webhook
   * update from the canceled intent is dropped by the `gen !== ...` guards
   * elsewhere.
   */
  async cancelIntent(intentId: string): Promise<void> {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    // `intentId` may arrive over RemoteCoreProxy from a tamperable browser
    // Shell. Reject non-string inputs explicitly — the truthiness check
    // alone admits objects / numbers that would pass the `if (!intentId)`
    // gate but fail downstream comparisons.
    if (typeof intentId !== "string" || !intentId) raiseError("intentId is required and must be a non-empty string.");
    const active = this._activeIntent;
    if (!active) return;
    if (active.id !== intentId) {
      raiseError(`cancelIntent id mismatch: expected ${active.id}, got ${intentId}.`);
    }
    // Snapshot the generation for a post-await supersede check. If a
    // key-change or other caller starts a fresh `requestIntent()` while
    // we are parked on the cancel network call, the replacement session
    // will have bumped `_generation` and rebuilt `_activeIntent`. Blindly
    // proceeding with the state-clear below would then wipe the NEW
    // session's intentId / amount / paymentMethod / status. Compare
    // generations after the await and bail if they no longer match.
    const activeGen = active.generation;
    if (active.mode === "payment") {
      try {
        // Keep `_activeIntent` and the current generation set while the
        // provider call is in flight — if Stripe rejects the cancel (network
        // error, intent already in a non-cancelable state), we surface the
        // error and leave ownership intact so the caller can retry or react
        // to incoming reports/webhooks for the same intent. Clearing state
        // before the await would zombify the intent: retries would hit the
        // `if (!active) return;` early-out and webhooks would stop folding.
        await this._provider.cancelPaymentIntent(intentId);
      } catch (e: unknown) {
        // Only surface the error if THIS cancel still owns the session.
        // If another requestIntent / reset has already taken over, the
        // user-visible truth is the new session, not our dead intent.
        const sanitized = this._sanitizeError(e);
        if (this._activeIntent?.generation === activeGen) {
          this._setError(sanitized);
        }
        // Sanitize the throw too, mirroring `requestIntent` /
        // `resumeIntent`. `_cancelIntent` is invoked by the Shell over
        // RemoteCoreProxy, which serializes thrown `Error` instances by
        // their raw `message` (and name/stack); without sanitization a
        // raw provider error would put un-allowlisted text on the wire.
        throw Object.assign(new Error(sanitized.message), sanitized.code ? { code: sanitized.code } : {});
      }
    } else if (this._cancelSetupIntents && this._provider.cancelSetupIntent) {
      try {
        await this._provider.cancelSetupIntent(intentId);
      } catch (e: unknown) {
        const sanitized = this._sanitizeError(e);
        if (this._activeIntent?.generation === activeGen) {
          this._setError(sanitized);
        }
        throw Object.assign(new Error(sanitized.message), sanitized.code ? { code: sanitized.code } : {});
      }
    }
    if (this._activeIntent?.generation !== activeGen) {
      // Superseded during the cancel await — a fresh session owns the
      // surface now. Do NOT clobber its state. The pi_OLD cancel did
      // happen at Stripe (that is what we requested), but the Core-side
      // lifecycle reset belongs to whoever now holds `_activeIntent`.
      return;
    }
    this._generation++;
    this._activeIntent = null;
    // Clear any error left over from a prior failed cancel attempt on this
    // same intent — on the success path the terminal state must be a clean
    // idle, mirroring requestIntent / resumeIntent / reset.
    this._setError(null);
    this._setStatus("idle");
    this._setLoading(false);
    this._setPaymentMethod(null);
    this._setIntentId(null);
    this._setAmount(null);
  }

  /**
   * Re-hydrate observable state from a 3DS redirect return. The Shell
   * reads the intent id AND Stripe-issued `client_secret` from the URL
   * (Stripe always puts both in `return_url`) and passes both through.
   *
   * Authorization model (default-secure — rejects by default):
   *
   *   1. **clientSecret check (always on).** The Core retrieves the
   *      intent server-side (authoritative, signed with the secret key)
   *      and rejects unless the caller-supplied `clientSecret` equals
   *      `intent.client_secret`. This is the same authorization Stripe
   *      itself uses for `stripe.retrievePaymentIntent(clientSecret)`:
   *      knowledge of the clientSecret is the evidence-of-ownership
   *      token. An attacker knowing only `pi_xxx` cannot resume.
   *
   *   2. **registerResumeAuthorizer (optional, additional).** For apps
   *      that want layered enforcement — e.g. "intent.metadata.userId
   *      must equal ctx.sub" — a custom authorizer is consulted after
   *      clientSecret match succeeds and before `_activeIntent` is
   *      rebuilt. Returning false rejects the resume.
   *
   * On successful authorization, `_activeIntent` is rebuilt so subsequent
   * `reportConfirmation` / `cancelIntent` / webhook events for this
   * intent flow normally. On any failure, `_activeIntent` is NOT touched
   * and observable state returns to `idle` with a sanitized error.
   *
   * The caller-supplied clientSecret is never stored — it is consumed
   * once for comparison and discarded. The SPEC §5.2 non-exposure
   * invariant (clientSecret not on the bindable surface, not in any
   * CustomEvent detail, not reflected to an attribute) remains intact.
   */
  async resumeIntent(intentId: string, mode: StripeMode, clientSecret: string): Promise<void> {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    // Same wire-untrusted reasoning as `cancelIntent`: tighten to string
    // type so a tampered payload (`intentId: { $eq: "" }`) cannot pass
    // the truthiness check.
    if (typeof intentId !== "string" || !intentId) raiseError("intentId is required and must be a non-empty string.");
    if (mode !== "payment" && mode !== "setup") {
      raiseError(`mode must be "payment" or "setup", got ${summarizeUntrustedValue(mode)}.`);
    }
    if (!clientSecret || typeof clientSecret !== "string") {
      // Reject before touching state — this path only fires when the
      // Shell's URL parsing yields an id without the matching secret,
      // which Stripe's redirect never does. A bare id without the
      // secret is almost certainly a tampered URL and must not grant
      // access to any intent.
      raiseError("clientSecret is required for resumeIntent (default-secure authorization).");
    }

    this._generation++;
    const gen = this._generation;
    this._setError(null);
    // Flip status BEFORE `_setLoading(true)` so observers never see the
    // half-state of "loading=true on a stale terminal status from a
    // prior session". `requestIntent` already establishes this order
    // (line 720-721 — `_setLoading(true)` then `_setStatus("processing")`,
    // both pre-await); resume's earlier shape skipped the status update
    // entirely, which left a session that was previously `succeeded` /
    // `failed` / `collecting` showing that terminal status with a
    // `loading=true` busy indicator on top until the provider retrieve
    // resolved. Status update first matches every other server-side
    // command's "I am owning the session now" signaling.
    this._setStatus("processing");
    this._setLoading(true);

    let view;
    try {
      view = await this._provider.retrieveIntent(mode, intentId);
    } catch (e: unknown) {
      // Sanitize the throw to keep raw provider errors off the wire.
      // Same rationale as `requestIntent`'s IntentBuilder / provider-create
      // catches. A transient provider failure during resume is not a
      // definitive Core decision — the Shell's `_resumeFromRedirect`
      // distinguishes Core-origin from transport via the seq counter (see
      // `_remoteErrorSeq`), but the message portion that the Shell
      // surfaces from the throw must still come through the same
      // allowlist as observable `_error`.
      const sanitized = this._sanitizeError(e);
      if (gen === this._generation) {
        this._setError(sanitized);
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw Object.assign(new Error(sanitized.message), sanitized.code ? { code: sanitized.code } : {});
    }

    if (gen !== this._generation) return; // superseded mid-flight

    // Ownership check. `view.clientSecret` is Stripe's authoritative value
    // for the intent; the caller must have been handed that same string by
    // Stripe's redirect URL. Any mismatch (tampered URL, foreign intent id,
    // provider that forgot to populate clientSecret) is a hard reject.
    // Constant-time compare to avoid leaking prefix length via timing.
    //
    // Always route through `clientSecretEquals` — including the
    // `view.clientSecret === undefined` branch — so the work profile of
    // the comparison is independent of whether the provider populated
    // the field. A short-circuit `!view.clientSecret ||` here would
    // return false from a synchronous truthiness check on the
    // missing-secret path and from a constant-time compare on the
    // present-but-wrong path, exposing a timing distinction between
    // "provider did not populate" and "secret does not match" that the
    // constant-time discipline elsewhere in this function takes pains
    // to suppress. The empty-string fallback (`view.clientSecret ?? ""`)
    // keeps the length-mismatch branch of `clientSecretEquals` reachable
    // — that branch performs the dummy compare against a fresh zero-
    // filled Buffer of the same length, preserving the documented
    // work-profile property.
    if (!clientSecretEquals(view.clientSecret ?? "", clientSecret)) {
      const err: StripeError = {
        code: "resume_client_secret_mismatch",
        message: "clientSecret does not match the retrieved intent -- resume denied.",
      };
      // Symmetric with the authorizer-failure branch below: only mutate
      // observable state if THIS resume still owns the Core generation.
      // A concurrent supersede would otherwise let the mismatch error and
      // an "idle" status stamp over a newer session's state. Today the
      // mismatch check runs synchronously after the retrieveIntent await
      // so the supersede window is closed, but keeping the guard defends
      // against future awaits being inserted upstream of this branch.
      if (gen === this._generation) {
        this._setError(err);
        this._setStatus("idle");
        this._setLoading(false);
      }
      throw Object.assign(new Error(err.message), { code: err.code });
    }

    // Optional defense-in-depth.
    if (this._resumeAuthorizer) {
      let ok: boolean;
      let authorizerThrew: unknown = null;
      // Strip `clientSecret` before handing the view to a third-party
      // authorizer. The authorizer's stated purpose is per-user / per-tenant
      // ACL on `intentId` / `metadata` — it does not need the bearer
      // credential. Passing it through would make a careless authorizer
      // implementation (`console.log(view)`, telemetry sink, error
      // re-throw with `view` in `cause`) the source of a clientSecret
      // leak that we explicitly forbid (SPEC §5.2 / §9.2). The Core
      // already verified the secret upstream; the authorizer sees an
      // intent view it cannot use to forge resume.
      const { clientSecret: _omitted, ...authorizerView } = view;
      try {
        ok = await this._resumeAuthorizer(intentId, mode, authorizerView, this._userContext);
      } catch (e: unknown) {
        // Authorizer threw. Normalize to the same `resume_not_authorized`
        // denial path as an explicit `false` return — a thrown authorizer
        // must not (a) grant access, nor (b) leak its raw exception
        // across the wire, where stack traces, DB error messages, and ACL
        // lookup internals would otherwise reach the Shell and any
        // observable subscriber. The original error is observable
        // server-side via the `stripe-checkout:authorizer-error` event on
        // this Core's target (operators can log it there) — it just does
        // not cross the remote boundary.
        authorizerThrew = e;
        ok = false;
      }
      if (!ok) {
        if (authorizerThrew !== null) {
          // Emit the raw exception on the Core's EventTarget for
          // server-side operator observability. Symmetric with
          // `stripe-checkout:webhook-warning` for non-fatal webhook handler
          // failures.
          this._target.dispatchEvent(new CustomEvent("stripe-checkout:authorizer-error", {
            detail: { error: authorizerThrew, intentId, mode },
            bubbles: true,
          }));
        }
        const err: StripeError = {
          code: "resume_not_authorized",
          message: "resume rejected by registered authorizer.",
        };
        if (gen === this._generation) {
          this._setError(err);
          this._setStatus("idle");
          this._setLoading(false);
        }
        throw Object.assign(new Error(err.message), { code: err.code });
      }
    }

    if (gen !== this._generation) return; // superseded during authorize

    this._activeIntent = { id: intentId, mode, generation: gen };
    this._setIntentId(intentId);
    this._reconcileFromIntentView(mode, view);
    // Terminal of the resume call — flip loading off only if the
    // reconciled status is not "processing". A 3DS redirect can land
    // while Stripe is still asynchronously finalizing the charge
    // (`intent.status === "processing"`), and `_reconcileFromIntentView`
    // deliberately keeps `loading = true` in that branch so the UI
    // spinner bridges the processing → succeeded/failed transition
    // delivered via webhook. Unconditionally clearing loading here
    // would drop the spinner mid-flight and make a still-in-progress
    // charge look idle.
    if (this._status !== "processing") {
      this._setLoading(false);
    }
  }

  /**
   * Return to a clean idle state. Does not talk to Stripe — `cancelIntent`
   * is the network-cancel path. Used by the Shell when Elements is
   * unmounted/remounted for a second attempt after failure, or by the app
   * when the component is reused for a new transaction.
   */
  reset(): void {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    this._generation++;
    this._activeIntent = null;
    this._setError(null);
    this._setPaymentMethod(null);
    this._setIntentId(null);
    this._setAmount(null);
    this._setStatus("idle");
    this._setLoading(false);
  }

  /**
   * Permanently decommission this Core. After dispose(), further command
   * calls (requestIntent / reportConfirmation / cancelIntent / resumeIntent
   * / reset / handleWebhook) `raiseError`, and all in-memory registrations
   * (intent builder, resume authorizer, webhook handlers, webhook dedup
   * window, active intent) are cleared.
   *
   * Secret clearing (SPEC §9.2): dispose also nulls out `_webhookSecret`,
   * `_userContext`, and the `_provider` reference. In a multi-tenant
   * server that creates a Core per tenant, a tenant removed after a
   * heap dump should not leave the webhook signing secret or the Stripe
   * SDK client (which holds `STRIPE_SECRET_KEY`) reachable in memory via
   * stray references to the disposed Core. The `_disposed` flag guards
   * every public command so the now-null `_provider` cannot be dereferenced
   * accidentally; TypeScript-wise the field stays typed as
   * `IStripeProvider` and we use a non-null assertion at assignment time.
   *
   * Intended for:
   *   - test teardown, so a Core from an earlier test cannot silently
   *     receive events meant for a later test's Core.
   *   - multi-tenant servers that build a Core per tenant and need to
   *     release registrations + secrets when the tenant is removed.
   *
   * Idempotent — calling dispose twice is a no-op. Does NOT notify Stripe
   * (no API call), so any still-pending intents at Stripe expire naturally.
   * Use cancelIntent first if you need deterministic remote cleanup.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    // Bump generation so any in-flight reportConfirmation / webhook fold
    // landing after this point is treated as a supersede and dropped by
    // the standard `gen !== this._generation` guards.
    this._generation++;
    this._activeIntent = null;
    this._intentBuilder = null;
    this._resumeAuthorizer = null;
    this._webhookHandlers.clear();
    this._seenWebhookIds.clear();
    // Drop secrets and the provider reference. The `_disposed` flag checked
    // at the top of every public command ensures none of these fields are
    // dereferenced after this point; the null assertion on `_provider` is
    // safe under that invariant. The `_target` EventTarget holds no secret
    // and is retained so late `dispatchEvent` calls (e.g. an already-
    // queued supersede guard) still have a target to hit.
    this._webhookSecret = null;
    this._userContext = undefined;
    this._provider = null!;
  }

  // --- Webhook ingress ---

  /**
   * Called from the app's HTTP route that receives Stripe webhooks. Verifies
   * the signature header against the webhook signing secret, dispatches the
   * parsed event to registered handlers, and folds common `payment_intent.*`
   * / `setup_intent.*` events back into observable state so subscribed Shells
   * see the terminal status without a round-trip through the client.
   *
   * `rawBody` must be the exact bytes Stripe POSTed — pass the string (or
   * Buffer/Uint8Array) BEFORE any JSON parse / re-serialize, because signature
   * verification includes a HMAC over the raw payload. Express's
   * `express.raw({ type: "application/json" })` yields a `Buffer`; Fastify's
   * raw body capture typically yields a `Buffer` or string; both shapes are
   * accepted here and forwarded verbatim to the provider. SPEC §9.3 / §6.2
   * ("Webhook endpoint の raw body 保全").
   *
   * `signatureHeader` is the value of the `stripe-signature` HTTP header.
   * Node's raw `req.headers` types the field as `string | string[] |
   * undefined`; for Stripe this is always a single value, but framework
   * surfaces sometimes normalize to an array. Pass `req.headers["stripe-
   * signature"]` directly — we reject the array shape loudly rather than
   * guess which element is canonical.
   *
   * Concurrency: `handleWebhook` is NOT a per-intent mutex. Interleaved
   * invocations on the same process (Fastify's parallel listeners,
   * µWebSockets, parallel dispatch from a pre-queue, etc.) can cause fold
   * state races — SPEC §6.2 recommends serializing webhooks per intent-id
   * on the HTTP route side. Single-process Express / Node-default path is
   * already sequential and does not need this.
   */
  async handleWebhook(rawBody: string | Buffer | Uint8Array, signatureHeader: string): Promise<void> {
    if (this._disposed) raiseError("StripeCore has been disposed.");
    if (!this._webhookSecret) {
      raiseError("handleWebhook called but StripeCore was constructed without webhookSecret.");
    }
    // Accept the shapes `express.raw()` and similar middleware produce.
    // Reject everything else explicitly so a caller passing `req` or a
    // parsed JSON object sees a clear error instead of a signature-
    // verification failure that looks like Stripe rejected it.
    const isBuffer = typeof Buffer !== "undefined" && Buffer.isBuffer(rawBody);
    if (
      typeof rawBody !== "string"
      && !isBuffer
      && !(rawBody instanceof Uint8Array)
    ) {
      raiseError("rawBody must be a string, Buffer, or Uint8Array.");
    }
    // `stripe-signature` is always a single value in practice, but Node's
    // `req.headers` typing admits `string[]` for repeated headers. A forged
    // / misrouted request could also deliver an array; treat that as
    // invalid rather than silently pick index 0, which would be a forgery-
    // friendly default.
    if (typeof signatureHeader !== "string" || !signatureHeader) {
      raiseError("signatureHeader must be a non-empty string.");
    }

    let event: StripeEvent;
    try {
      event = this._provider.verifyWebhook(rawBody, signatureHeader, this._webhookSecret);
    } catch (e: unknown) {
      // Signature verification failure must propagate so the HTTP route
      // returns 4xx and Stripe does not keep retrying a payload we cannot
      // trust. Do NOT sanitize into `this._error` — a forged request should
      // not mutate our observable state.
      //
      // Security note for HTTP routes: do NOT echo `err.message` to the
      // client response. The caller of this Core is a forged-or-bad
      // webhook sender, and `stripe-node`'s signature errors may reveal
      // internals (header format, key handle). Return a fixed 4xx body
      // (e.g. `"invalid signature"`) and log the underlying error
      // server-side instead.
      throw e;
    }

    // Dedup is checked BEFORE fold + handler dispatch, so a duplicate
    // delivery short-circuits both. This is intentional: refolding is
    // idempotent on its own, but re-running app handlers (which may write
    // to external systems) is not — that durability belongs to the
    // handler's own keying on `event.id`. SPEC §6.2 covers the parallel-
    // delivery serialization expectation that complements this in-process
    // window.
    //
    // `event.id`-empty contract: the dedup membership / insertion sites
    // below are guarded with `if (event.id)`, so an event arriving with
    // an empty / non-string `id` bypasses dedup entirely and runs
    // handlers on every retry. The default `StripeSdkProvider.
    // verifyWebhook` raises in this case (see provider for the
    // `event.id` non-empty check), but CUSTOM `IStripeProvider`
    // implementations MUST also guarantee a non-empty `event.id` after
    // signature verification or accept this dedup-bypass cost. A
    // future hardening could fail-loud here too, but that risks
    // breaking custom providers that intentionally pass synthetic
    // events through `handleWebhook` for tooling purposes (e.g.
    // replaying historical events from a backup queue); for now the
    // JSDoc is the contract.
    if (event.id && this._seenWebhookIds.has(event.id)) {
      this._target.dispatchEvent(new CustomEvent("stripe-checkout:webhook-deduped", {
        detail: { eventId: event.id, type: event.type },
        bubbles: true,
      }));
      return;
    }
    if (event.id) {
      this._seenWebhookIds.set(event.id, true);
      // Eviction: Map preserves insertion order, so `keys().next().value`
      // is the oldest id. `delete` is O(1). The old Set+Array pair used
      // `shift()` on the Array which is O(n); this branch stays O(1)
      // even at `_MAX_WEBHOOK_DEDUP_CAPACITY = 1_000_000`.
      //
      // `while` instead of `if`: with the current code path the size can
      // only ever exceed capacity by 1 per call (we just inserted one
      // entry), so a single delete keeps the invariant. But a future
      // refactor — e.g. exposing a setter that shrinks
      // `_webhookDedupCapacity` at runtime, or restoring entries from a
      // persisted dedup state — could leave `size` more than 1 over
      // capacity at entry. Looping costs nothing in the common case (the
      // condition is false on the second iteration) and turns the
      // invariant from "true on every code path today" into "true after
      // this block runs, regardless of how we got here".
      while (this._seenWebhookIds.size > this._webhookDedupCapacity) {
        const oldest = this._seenWebhookIds.keys().next().value;
        if (oldest === undefined) break;
        this._seenWebhookIds.delete(oldest);
      }
    }

    // Reflect common event types into observable state BEFORE app handlers.
    // Trade-off: if a fatal handler throws, UI may transiently observe a
    // terminal state (e.g. succeeded) while the webhook HTTP route returns
    // 5xx and Stripe retries. This is intentional eventual consistency:
    // retries re-run fold idempotently, while handler-side durability still
    // controls acknowledgement semantics.
    //
    // Only the currently-active intent is folded in; events for other intents
    // (different user, old session) pass through to handlers but do not move
    // UI state.
    await this._foldWebhookIntoState(event);

    // Dispatch to registered handlers. Fatal/non-fatal semantics mirror
    // s3-uploader's registerPostProcess. Run sequentially so a fatal throw
    // aborts the chain deterministically and the HTTP route sees the
    // rejection before Stripe considers the webhook delivered.
    //
    // Snapshot the handler array BEFORE iterating: a handler may call
    // its own returned disposer (`unregister()` from
    // `registerWebhookHandler`), which `splice`s the entry out of the
    // backing array. A `for-of` iterator over the live array would then
    // skip the NEXT entry (the splice shifts every subsequent element
    // down by one index, and the iterator's internal index advances
    // independently). Conversely, a handler that REGISTERS a new
    // handler mid-fire would have the new entry observed by the same
    // iteration, leading to "handler fires on the event that registered
    // it" surprise. Both pathological behaviors are pinned down by
    // freezing the dispatch list at entry: it captures the set of
    // handlers as-of when this event arrived, and any registration
    // changes apply to the NEXT event only.
    const rawHandlers = this._webhookHandlers.get(event.type);
    if (!rawHandlers || rawHandlers.length === 0) return;
    const handlers = [...rawHandlers];
    for (const entry of handlers) {
      // A handler may have invoked `dispose()` during its own await,
      // which `clear()`s `_webhookHandlers` (line ~1334). The `for-of`
      // iterator over the array we snapshotted to `handlers` keeps
      // running independently of that mutation, so without this guard
      // every subsequent handler in this event's chain would run on a
      // disposed Core — re-dispatching on the released `_target`
      // EventTarget and (worse) pulling the disposed-and-nulled
      // `_provider` into any retrieve-fallback the handler triggers.
      // The Map.delete + Array snapshot patterns elsewhere in this
      // method (`_seenWebhookIds.delete(event.id)` on fatal re-throw)
      // also stop being meaningful after dispose; short-circuiting is
      // the only safe action.
      if (this._disposed) return;
      try {
        await entry.handler(event);
      } catch (e: unknown) {
        if (entry.fatal) {
          // Fatal errors opt back into Stripe retry semantics by removing
          // this event id from the in-memory dedup window before rethrow.
          // `Map.delete` is O(1); the old `Array.indexOf` + `splice` pair
          // was O(n) against the dedup capacity.
          if (event.id) this._seenWebhookIds.delete(event.id);
          throw e;
        }
        this._target.dispatchEvent(new CustomEvent("stripe-checkout:webhook-warning", {
          detail: { error: e, event },
          bubbles: true,
        }));
      }
    }
  }

  /**
   * Reflect a `payment_intent.*` / `setup_intent.*` webhook event back into
   * observable state. Scope-narrowed by design:
   *
   * - Only fires when an `_activeIntent` matches `event.data.object.id`. Stale
   *   events (different intent, no active session) pass through to handlers
   *   without touching observable state.
   * - Only branches on the canonical `payment_intent.{succeeded,payment_failed,
   *   requires_action,processing,canceled}` and the SetupIntent equivalents.
   *   `charge.*`, `customer.*`, `invoice.*`, and other event families are
   *   intentionally NOT folded here — those carry domain semantics (refunds,
   *   billing, fraud signals) that the generic `status` / `error` surface
   *   cannot represent without lossy collapse. Apps that need to react to
   *   them must register their own `WebhookHandler` via
   *   `registerWebhookHandler` (see `handleWebhook` jsdoc and SPEC §6.2).
   */
  private async _foldWebhookIntoState(event: StripeEvent): Promise<void> {
    // Dispose check at the top: a handler invoked earlier in the same
    // `handleWebhook` call (or a sibling routine on the same Core
    // instance) may have already called `dispose()` synchronously
    // before this fold runs. `_activeIntent` is null'd in dispose, so
    // the immediate `!active` guard below catches the common case —
    // but a post-await race in the succeeded branch's retrieve
    // fallback could still attempt to call `_setPaymentMethod` /
    // `_setStatus` on a target that has already been GC'd from the
    // Shell's reference, dispatching events that no listener owns.
    // Short-circuit explicitly so the read of `_provider` (which is
    // nulled in dispose) inside the retrieve fallback below can never
    // throw.
    if (this._disposed) return;
    const active = this._activeIntent;
    if (!active) return;
    const obj = event.data?.object as Record<string, unknown> | undefined;
    if (!obj) return;
    // `obj` is already non-null (guarded above) so only the string-check
    // on `obj.id` is needed. The previous `obj && typeof obj.id === ...`
    // shape re-checked `obj` unnecessarily.
    const objId = typeof obj.id === "string" ? obj.id : undefined;
    if (!objId || objId !== active.id) return;
    // Cross-mode defense. Stripe uses type-prefixed ids (`pi_` / `seti_`)
    // so accidental id collision between a SetupIntent event and the
    // active PaymentIntent is already extraordinarily unlikely, but
    // checking the `event.type` prefix matches `active.mode` closes the
    // theoretical window where a custom provider (or a future Stripe
    // change) produces cross-shaped payloads. Without this, a
    // `setup_intent.succeeded` event with a colliding id would fold onto
    // a `mode="payment"` session and flip its status.
    const expectedPrefix = active.mode === "payment" ? "payment_intent." : "setup_intent.";
    if (!event.type.startsWith(expectedPrefix)) return;
    // Snapshot the generation at entry. Any branch below that awaits must
    // re-check this before mutating observable state — otherwise a
    // concurrent `reset()` / new `requestIntent()` during the await would
    // let the old intent's pm / status / error bleed into the new
    // session's UI. Same discipline `reportConfirmation` already uses.
    const gen = active.generation;

    switch (event.type) {
      case "payment_intent.succeeded":
      case "setup_intent.succeeded": {
        // If reportConfirmation's succeeded branch failed to populate
        // paymentMethod (transient retrieve error, Stripe.js returned a
        // bare pm id, etc.) or was never invoked (pure webhook-driven
        // path), recover here. Prefer the webhook event's payload —
        // Stripe sometimes expands `payment_method` on specific webhook
        // types — then fall back to a fresh server-side retrieve. This
        // is the last-chance fill described in SPEC §6.4.
        if (!this._paymentMethod && obj) {
          const pmFromEvent = extractCardPaymentMethod(obj);
          if (pmFromEvent) {
            this._setPaymentMethod(pmFromEvent);
          } else {
            try {
              const view = await this._provider.retrieveIntent(active.mode, active.id);
              // Supersede / dispose guard: the only await in this fold
              // method. Without these checks, a stale retrieve landing
              // after `reset()` + new `requestIntent()` would paint
              // pi_OLD's card onto pi_NEW's observable state, and a
              // retrieve resolving after `dispose()` would dispatch on
              // a target the Shell no longer holds. Returning early on
              // either keeps the fold from mutating state past its
              // ownership boundary.
              if (this._disposed || gen !== this._generation) return;
              if (view.paymentMethod) this._setPaymentMethod(view.paymentMethod);
            } catch {
              /* best-effort. Fall through — but the guard below still
                 covers the case where generation advanced DURING the
                 failed retrieve. */
            }
          }
        }
        // Generation may have advanced either during the retrieve await
        // (handled above) or while we were parked before reaching this
        // line. Re-check before flipping status / loading so we do not
        // stamp "succeeded" onto a new session that is currently
        // mid-prepare. Also re-check dispose: a handler downstream in
        // the same handleWebhook chain (or a parallel routine) could
        // have disposed the Core between the retrieve resolve above
        // and this dispatch.
        if (this._disposed || gen !== this._generation) return;
        // Clear any lingering failure (e.g. a prior card_declined from
        // a retried attempt on the same intent) so the terminal
        // observable surface matches the success.
        this._setError(null);
        this._setStatus("succeeded");
        this._setLoading(false);
        break;
      }
      case "payment_intent.payment_failed":
      case "setup_intent.setup_failed": {
        // Terminal-state guard. SPEC §6.2 says webhook ordering /
        // serialization per-intent is the app's responsibility (Stripe
        // delivers in best-effort order, and parallel HTTP route
        // workers can interleave deliveries even from a serial source).
        // Without an idempotent terminal lock here, a late
        // `payment_intent.payment_failed` for the same intent that
        // arrives AFTER `succeeded` was already folded would flip the
        // observable surface back to `"failed"` — silently demoting a
        // confirmed payment. Once status reaches `succeeded`, this
        // Core treats it as terminal-authoritative for the active
        // intent's lifetime; new info that contradicts it MUST come
        // from a separate flow (a chargeback / refund pipeline that
        // the app wires through its own webhook handler against
        // `charge.refunded` / `charge.dispute.created`, not from this
        // fold method which is `payment_intent.*` only).
        if (this._status === "succeeded") return;
        const le = obj.last_payment_error ?? obj.last_setup_error;
        if (le) this._setError(this._sanitizeError(le));
        this._setStatus("failed");
        this._setLoading(false);
        break;
      }
      case "payment_intent.requires_action":
      case "setup_intent.requires_action":
        // Note: `*.requires_confirmation` is a valid intent STATUS (visible
        // via retrieve and handled in `_reconcileFromIntentView`), but it
        // is NOT a webhook event type per Stripe's event-types catalog.
        // `_foldWebhookIntoState` therefore deliberately does not branch
        // on it.
        //
        // Terminal-state guard (same rationale as payment_failed above).
        // A late `requires_action` re-delivery for an intent that has
        // already succeeded must not demote the observable surface
        // back to the pre-terminal challenge state — the UI would
        // re-show "complete the 3DS challenge" for a payment the
        // customer already authorized.
        if (this._status === "succeeded") return;
        this._setStatus("requires_action");
        // Mirror reportConfirmation's requires_action branch: the
        // user is now owning the flow (3DS challenge, redirect, etc),
        // so the server-side "busy" flag must clear — otherwise a
        // session that was `loading=true` during processing stays
        // stuck on the spinner even though the UI should be showing
        // the challenge.
        this._setLoading(false);
        break;
      case "payment_intent.processing":
      case "setup_intent.processing":
        // Terminal-state guard. A late `processing` re-delivery on a
        // succeeded intent would flip status back to `processing` +
        // `loading: true`, hanging the spinner indefinitely on a
        // payment that already cleared.
        if (this._status === "succeeded") return;
        this._setStatus("processing");
        this._setLoading(true);
        break;
      case "payment_intent.canceled":
      case "setup_intent.canceled": {
        // Mirror the payment_failed / setup_failed branch above — a
        // canceled intent can carry `last_payment_error` / `last_setup_
        // error` that explains why (declined attempt that preceded the
        // cancel, for example). Without this, cancellation-by-failure
        // arrives on the Shell as a silent "failed" with no diagnostic.
        //
        // Terminal-state guard (same rationale as payment_failed).
        // Stripe should never deliver a `canceled` after a `succeeded`
        // for the same intent (the state machine on Stripe's side
        // disallows it), but a re-delivery / replay path could surface
        // an OUT-OF-ORDER pair if the canceled event was delayed
        // beyond the succeeded one — refuse to demote in that case.
        if (this._status === "succeeded") return;
        const le = obj.last_payment_error ?? obj.last_setup_error;
        if (le) this._setError(this._sanitizeError(le));
        this._setStatus("failed");
        this._setLoading(false);
        break;
      }
    }
  }

}
