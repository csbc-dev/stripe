import {
  IStripeProvider, IntentCreationResult, PaymentIntentOptions, SetupIntentOptions,
  StripeMode, StripeIntentView, StripeEvent, StripeAmount, StripeError,
} from "../types.js";
import { raiseError } from "../raiseError.js";
import { extractCardPaymentMethod } from "../internal/paymentMethodShape.js";

/**
 * Minimal structural view of the subset of the `stripe` (stripe-node) package
 * surface this provider needs. Typed here rather than imported from the
 * `stripe` package so the `stripe` peer dependency stays optional — apps
 * that supply their own provider (e.g. a mock in tests) do not need stripe
 * installed at all.
 *
 * A real stripe-node client fits this shape structurally; the constructor
 * also accepts a plain object for tests.
 */
export interface StripeNodeLike {
  paymentIntents: {
    create(
      params: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ): Promise<Record<string, unknown>>;
    retrieve(id: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    cancel(id: string): Promise<Record<string, unknown>>;
  };
  setupIntents: {
    create(
      params: Record<string, unknown>,
      options?: { idempotencyKey?: string },
    ): Promise<Record<string, unknown>>;
    retrieve(id: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * Present on real stripe-node clients but optional here so tests/mocks
     * are not forced to implement it. The default StripeCore policy
     * intentionally does not call SetupIntent cancel (cost optimization);
     * apps that want explicit cleanup can implement it in a custom provider.
     */
    cancel?(id: string): Promise<Record<string, unknown>>;
  };
  webhooks: {
    // `stripe-node` accepts string | Buffer | Uint8Array for `payload` —
    // match that exactly so `express.raw()` (Buffer) and `bodyParser.text()`
    // (string) both flow through without coercion. Keeps the verification
    // HMAC over the exact bytes Stripe POSTed.
    constructEvent(
      payload: string | Buffer | Uint8Array,
      header: string,
      secret: string,
    ): Record<string, unknown>;
  };
}

export interface StripeSdkProviderIdempotencyContext {
  operation: "createPaymentIntent" | "createSetupIntent";
  mode: StripeMode;
  options: PaymentIntentOptions | SetupIntentOptions;
}

export interface StripeSdkProviderOptions {
  buildIdempotencyKey?: (ctx: StripeSdkProviderIdempotencyContext) => string | undefined;
}

/**
 * @internal — Symbol-keyed escape hatch for test-only reset of the
 * one-shot "missing buildIdempotencyKey" warning. Exported as a Symbol
 * (rather than a public-named method) so the seam is not reachable
 * via simple string indexing like
 * `(StripeSdkProvider as any)._resetWarnings()` — the previous shape.
 *
 * Privacy boundary — what this Symbol IS and IS NOT:
 *
 *   - IS: indirection. Production code that has not imported
 *     `_internalResetWarnings` cannot index into the class by a
 *     guessable / autocomplete-able name. The previous string-keyed
 *     form was discoverable from any IDE that lists class members.
 *
 *   - IS NOT: hard isolation. The Symbol is still reflected on the
 *     class. `Object.getOwnPropertySymbols(StripeSdkProvider)` lists
 *     it; a sufficiently determined caller can grab it without an
 *     import. This is not an attack vector — the worst that can
 *     happen is the latch resets and the warning fires once more —
 *     but consumers MUST NOT treat this seam as a privacy primitive.
 *
 * Test-only usage (the contract this seam exists to serve):
 *   import { StripeSdkProvider, _internalResetWarnings } from "...";
 *   (StripeSdkProvider as any)[_internalResetWarnings]();
 *
 * Public API stability is not guaranteed; the Symbol's identity may
 * change between minor versions.
 */
export const _internalResetWarnings: unique symbol = Symbol("@csbc-dev/stripe/internal/resetWarnings");

function extractAmount(obj: Record<string, unknown>): StripeAmount | undefined {
  const value = obj.amount;
  const currency = obj.currency;
  if (typeof value === "number" && typeof currency === "string") {
    return { value, currency };
  }
  return undefined;
}

/**
 * Extract `last_payment_error` / `last_setup_error` from a retrieved
 * Stripe intent into the `StripeError` shape `StripeIntentView` carries.
 *
 * **Caller MUST sanitize the result before letting it cross the wire or
 * reach observable state.** This helper performs only typeof / shape
 * normalization (`code`, `decline_code` → `declineCode`, `type`,
 * `message`); it does NOT taxonomy-gate `code` / `declineCode` / `type`,
 * does NOT length-cap `message`, and does NOT collapse non-Stripe-shaped
 * errors to "Payment failed." The Core's `_reconcileFromIntentView`
 * re-runs `_sanitizeError` on `view.lastPaymentError` before any
 * `_setError` call, which is the boundary where the allowlist + length
 * cap + Stripe-shape check actually run. Provider-level callers that
 * surface this struct anywhere else (custom IStripeProvider wrappers,
 * test introspection on a `StripeIntentView`) MUST mirror that
 * sanitization before broadcast.
 */
function extractLastPaymentError(obj: Record<string, unknown>): StripeError | undefined {
  const err = obj.last_payment_error ?? obj.last_setup_error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    // If `message` is not a string, return `undefined` instead of
    // synthesizing a generic "Payment failed." here. The Core's
    // `_reconcileFromIntentView` re-runs `_sanitizeError` over this
    // result before letting it touch observable state — if we fill in
    // a generic message at this layer, the Core sanitizer sees an
    // object with a real `type: "card_error"` AND our synthesized
    // `message: "Payment failed."` and forwards both, producing the
    // misleading "real Stripe error type but generic message"
    // half-state the reviewer flagged. Returning `undefined` here
    // lets the Core fall back to "no error reported", and the
    // subsequent webhook path can fill it in with the real Stripe
    // payload when it arrives.
    if (typeof e.message !== "string") return undefined;
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      declineCode: typeof e.decline_code === "string" ? e.decline_code : undefined,
      type: typeof e.type === "string" ? e.type : undefined,
      message: e.message,
    };
  }
  return undefined;
}

/**
 * Default `IStripeProvider` implementation backed by the `stripe` (node)
 * package. Holds the secret key indirectly — the app passes a constructed
 * `Stripe` client into the constructor, so the secret lives in exactly one
 * place (the client) and this provider is just an adapter.
 *
 * Apps that need custom behavior (e.g. injecting `idempotency_key` per
 * request, routing to a mock in tests, switching accounts per tenant) can
 * either wrap this provider or implement `IStripeProvider` directly — the
 * Core never imports `stripe` itself, so there is no hidden coupling.
 */
export class StripeSdkProvider implements IStripeProvider {
  private _client: StripeNodeLike;
  private _buildIdempotencyKey?: StripeSdkProviderOptions["buildIdempotencyKey"];

  /**
   * Module-scoped latch so the "no buildIdempotencyKey" warning fires at
   * most once per process. The Core-level invariant in CLAUDE.md
   * ("Idempotent intent creation — without buildIdempotencyKey, network
   * flake creates duplicate intents") makes the omission worth flagging,
   * but a per-instance warning would flood logs in multi-tenant servers
   * that build a Provider per tenant. One warning per process is enough
   * to nudge the operator to a deliberate decision; repeated noise just
   * trains the operator to filter it out.
   *
   * Test reachability: import the Symbol `_internalResetWarnings` from
   * this module and invoke
   * `(StripeSdkProvider as any)[_internalResetWarnings]()` in
   * test setup. Symbol-keyed seam keeps the latch from being
   * reachable via simple `(StripeSdkProvider as any)._resetWarnings()`
   * indexing from code that did not deliberately import the Symbol —
   * which was the reviewer's concern about the previous public-named
   * static method. The warning is a one-shot diagnostic, not a
   * programmable lifecycle event.
   */
  private static _warnedAboutMissingIdempotencyKey: boolean = false;

  /**
   * Symbol-keyed reset accessor. Indexed by the module-exported
   * `_internalResetWarnings` Symbol; production code that does not
   * import the Symbol cannot reach this method. Public API stability
   * is not guaranteed; the Symbol's identity may change between
   * minor versions.
   */
  static [_internalResetWarnings](): void {
    StripeSdkProvider._warnedAboutMissingIdempotencyKey = false;
  }

  constructor(client: StripeNodeLike, options: StripeSdkProviderOptions = {}) {
    if (!client) raiseError("stripe client is required.");
    if (
      options.buildIdempotencyKey !== undefined
      && typeof options.buildIdempotencyKey !== "function"
    ) {
      raiseError("buildIdempotencyKey must be a function.");
    }
    this._client = client;
    this._buildIdempotencyKey = options.buildIdempotencyKey;
    // Fail-loud nudge for the no-idempotency-key default. The seam is
    // optional by design (apps that genuinely want a different dedup
    // story plug their own), but the silent default — no key at all —
    // means a network flake during `paymentIntents.create` lets Stripe
    // create duplicate intents on retry. That is a real money-side
    // exposure, not a soft-best-practice nit, so surface it once.
    if (
      options.buildIdempotencyKey === undefined
      && !StripeSdkProvider._warnedAboutMissingIdempotencyKey
    ) {
      StripeSdkProvider._warnedAboutMissingIdempotencyKey = true;
      // `globalThis.console` rather than a bare `console` reference so
      // a server runtime with a stubbed console (workers, custom shim)
      // never crashes here.
      const c = (globalThis as { console?: { warn?: (...args: unknown[]) => void } }).console;
      if (c && typeof c.warn === "function") {
        c.warn(
          "[@csbc-dev/stripe] StripeSdkProvider constructed without "
          + "`buildIdempotencyKey`. Without an idempotency key, a network "
          + "retry during paymentIntents.create can result in duplicate "
          + "PaymentIntents (and a duplicate authorization hold on the "
          + "customer's card). Provide `new StripeSdkProvider(client, { "
          + "buildIdempotencyKey: (ctx) => crypto.randomUUID() })` (or a "
          + "request-correlated key) for production deployments.",
        );
      }
    }
  }

  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    // Stripe expects amount in the smallest currency unit (cents / yen /
    // minor-unit integer). A fractional value would be rejected by the
    // Stripe API with an opaque server-side error; reject locally for
    // faster feedback and a clearer diagnostic.
    //
    // Upper bound: deliberately NOT enforced here. Stripe's per-currency
    // limits are well-published but vary (e.g. USD ~999,999,999 cents,
    // JPY higher in absolute units) and shift over time as Stripe adjusts
    // its risk thresholds. Hardcoding a ceiling at this layer would
    // either be wrong-for-some-currency or quickly become stale. The
    // IntentBuilder is the documented seam for amount validation
    // (CLAUDE.md "The server decides the amount.") — apps with a real
    // upper bound concern (cart caps, fraud thresholds, tier-based
    // limits) MUST validate amount inside their IntentBuilder against
    // their authenticated UserContext / cart store before this method
    // is reached. The Stripe API rejection on overage remains the
    // backstop for misconfigured builders.
    if (!Number.isInteger(opts.amount) || opts.amount <= 0) {
      raiseError(`amount must be a positive integer in the smallest currency unit, got ${opts.amount}.`);
    }
    // Currency shape: required, three lowercase ASCII letters per
    // Stripe's published contract (`"usd"`, `"jpy"`, `"eur"`, …).
    // Stripe accepts uppercase / mixed-case variants too, but
    // normalizes them server-side; rejecting non-lowercase here keeps
    // app code aligned with the documented shape and avoids a class of
    // subtle bugs (`"USD" !== "usd"` string compare in app-side cart
    // logic). A 3-letter ISO-4217 check is the minimum cost
    // self-defense; deeper currency validation (the actual ISO list,
    // currency-vs-amount unit alignment) is the IntentBuilder's
    // responsibility — that boundary already owns "the server decides
    // the amount" per CLAUDE.md, and it has access to the per-tenant
    // cart store / pricing service that knows which currencies are
    // legitimate.
    if (typeof opts.currency !== "string" || !/^[a-z]{3}$/.test(opts.currency)) {
      raiseError(`currency must be a 3-letter lowercase ISO 4217 code (e.g. "usd"), got ${JSON.stringify(opts.currency)}.`);
    }
    // Symmetric checks with `createSetupIntent` — optional fields whose
    // shape is well-defined enough to fail loud at this layer rather
    // than wait for an opaque Stripe API rejection.
    if (opts.customer !== undefined && typeof opts.customer !== "string") {
      raiseError(`customer must be a string when provided, got ${JSON.stringify(opts.customer)}.`);
    }
    if (opts.payment_method_types !== undefined) {
      if (!Array.isArray(opts.payment_method_types)) {
        raiseError(`payment_method_types must be an array when provided, got ${typeof opts.payment_method_types}.`);
      }
      for (const t of opts.payment_method_types) {
        if (typeof t !== "string") {
          raiseError(`payment_method_types entries must be strings, got ${typeof t}.`);
        }
      }
    }
    // Default to automatic_payment_methods when the caller did not opt out —
    // it is Stripe's recommended path and it supports the widest range of
    // Elements-based confirmation flows without the app having to enumerate
    // payment_method_types.
    //
    // Treat `payment_method_types: []` the same as "unset": the empty array
    // is truthy in JavaScript but conveys no real intent to Stripe, and
    // forwarding it would trigger a hard 400 ("payment_method_types[] is
    // empty") that looks like a Stripe API bug. Strip it and then apply
    // the automatic_payment_methods default so the caller lands on the
    // same well-defined path as if the field had been omitted entirely.
    const params: Record<string, unknown> = { ...opts };
    if (Array.isArray(params.payment_method_types) && params.payment_method_types.length === 0) {
      delete params.payment_method_types;
    }
    if (params.automatic_payment_methods === undefined && params.payment_method_types === undefined) {
      params.automatic_payment_methods = { enabled: true };
    }
    const idempotencyKey = this._buildIdempotencyKey?.({
      operation: "createPaymentIntent",
      mode: "payment",
      options: opts,
    });
    const result = await this._client.paymentIntents.create(
      params,
      // Forward when the builder returned a string (including ""). A
      // truthiness check would silently drop an empty-string key, turning
      // a buggy builder into a hard-to-debug no-op. Stripe will reject
      // empty keys with a clear API-side error, which is better than
      // silent degradation to non-idempotent behavior.
      idempotencyKey !== undefined ? { idempotencyKey } : undefined,
    );
    const id = typeof result.id === "string" ? result.id : "";
    const clientSecret = typeof result.client_secret === "string" ? result.client_secret : "";
    if (!id || !clientSecret) {
      raiseError("stripe.paymentIntents.create returned no id/client_secret.");
    }
    return {
      intentId: id,
      clientSecret,
      mode: "payment",
      amount: extractAmount(result),
    };
  }

  async createSetupIntent(opts: SetupIntentOptions): Promise<IntentCreationResult> {
    // Symmetric input validation with `createPaymentIntent`. Each of
    // these checks rejects locally for faster, clearer feedback than
    // a remote Stripe API rejection — and protects against tampered
    // wire payloads reaching here through a custom IntentBuilder that
    // forgot to validate its own output:
    //
    // - `customer`: optional, but if present must be a string. Stripe
    //   uses it as the `cus_...` foreign key; a non-string would
    //   produce an opaque server-side rejection.
    // - `usage`: enum (`"on_session"` / `"off_session"`) per Stripe's
    //   SetupIntent API. A typo'd literal here defaults Stripe to
    //   `"off_session"` silently in some response shapes.
    // - `payment_method_types`: optional array of strings.
    //
    // `createPaymentIntent`'s `amount` / `currency` checks have no
    // counterpart on this surface (SetupIntents do not carry an
    // amount), so the symmetric check is by-field rather than
    // by-field-list. Other optional Stripe SetupIntent params (e.g.
    // `description`, `metadata`, `payment_method_options`) pass
    // through untouched — the Stripe API is the ultimate gate for
    // their shape.
    if (opts.customer !== undefined && typeof opts.customer !== "string") {
      raiseError(`customer must be a string when provided, got ${JSON.stringify(opts.customer)}.`);
    }
    if (opts.usage !== undefined && opts.usage !== "on_session" && opts.usage !== "off_session") {
      raiseError(`usage must be "on_session" or "off_session", got ${JSON.stringify(opts.usage)}.`);
    }
    if (opts.payment_method_types !== undefined) {
      if (!Array.isArray(opts.payment_method_types)) {
        raiseError(`payment_method_types must be an array when provided, got ${typeof opts.payment_method_types}.`);
      }
      for (const t of opts.payment_method_types) {
        if (typeof t !== "string") {
          raiseError(`payment_method_types entries must be strings, got ${typeof t}.`);
        }
      }
    }
    // Treat an empty `payment_method_types` array as unset so the
    // automatic-payment-methods default applies cleanly.
    const params: Record<string, unknown> = { ...opts };
    if (Array.isArray(params.payment_method_types) && params.payment_method_types.length === 0) {
      delete params.payment_method_types;
    }
    if (params.automatic_payment_methods === undefined && params.payment_method_types === undefined) {
      params.automatic_payment_methods = { enabled: true };
    }
    const idempotencyKey = this._buildIdempotencyKey?.({
      operation: "createSetupIntent",
      mode: "setup",
      options: opts,
    });
    const result = await this._client.setupIntents.create(
      params,
      // Forward when the builder returned a string (including ""). A
      // truthiness check would silently drop an empty-string key, turning
      // a buggy builder into a hard-to-debug no-op. Stripe will reject
      // empty keys with a clear API-side error, which is better than
      // silent degradation to non-idempotent behavior.
      idempotencyKey !== undefined ? { idempotencyKey } : undefined,
    );
    const id = typeof result.id === "string" ? result.id : "";
    const clientSecret = typeof result.client_secret === "string" ? result.client_secret : "";
    if (!id || !clientSecret) {
      raiseError("stripe.setupIntents.create returned no id/client_secret.");
    }
    return {
      intentId: id,
      clientSecret,
      mode: "setup",
    };
  }

  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    if (!id) raiseError("id is required.");
    // Expand `payment_method` so brand / last4 are present in the response.
    // Without this, Stripe returns `payment_method` as a bare id string and
    // we cannot surface card details to the UI without a second round-trip.
    // The Core's succeeded-branch paymentMethod fallback relies on this
    // returning expanded data (SPEC §5.1 paymentMethod contract).
    const opts = { expand: ["payment_method"] };
    const result = mode === "payment"
      ? await this._client.paymentIntents.retrieve(id, opts)
      : await this._client.setupIntents.retrieve(id, opts);
    // Narrow `metadata` to the documented `Record<string, string>` shape.
    // Stripe's API contract pins string→string, but a future client-side
    // change (or a custom-tweaked stripe-node) could surface non-string
    // values; copying field-by-field guards against silent ABI drift
    // landing in `ResumeAuthorizer` callbacks. Drop non-string values
    // rather than coerce — an authorizer doing `intentView.metadata.userId
    //  === ctx.sub` must observe absence over a coerced `String(...)` slot.
    let metadata: Record<string, string> | undefined;
    if (result.metadata && typeof result.metadata === "object") {
      const raw = result.metadata as Record<string, unknown>;
      const narrowed: Record<string, string> = {};
      let any = false;
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (typeof v === "string") {
          narrowed[k] = v;
          any = true;
        }
      }
      if (any) metadata = narrowed;
    }
    return {
      id: typeof result.id === "string" ? result.id : id,
      status: typeof result.status === "string" ? result.status : "unknown",
      mode,
      amount: extractAmount(result),
      paymentMethod: extractCardPaymentMethod(result),
      lastPaymentError: extractLastPaymentError(result),
      metadata,
      // Stripe's PaymentIntent/SetupIntent retrieve returns `client_secret`
      // on every call. The Core uses it exclusively to validate that a
      // resume call (from a post-3DS URL) actually knows the secret —
      // never stored, never emitted. See StripeIntentView.clientSecret.
      clientSecret: typeof result.client_secret === "string" ? result.client_secret : undefined,
    };
  }

  async cancelPaymentIntent(id: string): Promise<void> {
    if (!id) raiseError("id is required.");
    await this._client.paymentIntents.cancel(id);
  }

  async cancelSetupIntent(id: string): Promise<void> {
    if (!id) raiseError("id is required.");
    if (typeof this._client.setupIntents.cancel !== "function") {
      raiseError("stripe.setupIntents.cancel is not available on this client.");
    }
    await this._client.setupIntents.cancel(id);
  }

  verifyWebhook(rawBody: string | Buffer | Uint8Array, signatureHeader: string, secret: string): StripeEvent {
    // Delegates to stripe-node's constructEvent, which performs the HMAC-SHA256
    // over the raw body + timestamp check. It throws on failure — we let the
    // throw propagate so StripeCore.handleWebhook returns the error to the
    // HTTP route unchanged (4xx → Stripe stops retrying a forged request).
    const event = this._client.webhooks.constructEvent(rawBody, signatureHeader, secret);
    // Stripe's contract guarantees `id` and `type` on every event that
    // passes signature verification. A missing value here means the SDK
    // contract is broken (or something tampered post-verify); downgrading
    // to an empty string would bypass the dedup window (empty id never
    // matches) and silently skip every handler (empty type dispatches
    // nothing). Fail loud instead.
    if (typeof event.id !== "string" || event.id === "") {
      raiseError("verifyWebhook: Stripe event has no id after signature verification.");
    }
    if (typeof event.type !== "string" || event.type === "") {
      raiseError("verifyWebhook: Stripe event has no type after signature verification.");
    }
    return {
      id: event.id as string,
      type: event.type as string,
      data: (event.data as { object: Record<string, unknown> }) ?? { object: {} },
      created: typeof event.created === "number" ? event.created : 0,
    };
  }
}
