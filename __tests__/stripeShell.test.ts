import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Stripe as WcsStripe } from "../src/components/Stripe";
import { StripeCore } from "../src/core/StripeCore";
import { setConfig, config as stripeConfig } from "../src/config";
import type {
  StripeJsLike, StripeElementsLike, StripePaymentElementLike,
} from "../src/components/Stripe";
import type {
  IStripeProvider, IntentCreationResult, PaymentIntentOptions, SetupIntentOptions,
  StripeEvent, StripeIntentView, StripeMode,
} from "../src/types";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type {
  ClientTransport, ServerTransport, ClientMessage, ServerMessage,
} from "@wc-bindable/remote";

class FakeProvider implements IStripeProvider {
  nextPaymentIntentId = "pi_shell";
  nextClientSecret = "cs_shell_secret";
  retrieveCalls: { mode: StripeMode; id: string }[] = [];
  retrieveResult: StripeIntentView | null = null;
  cancelCalls: string[] = [];
  async createPaymentIntent(opts: PaymentIntentOptions): Promise<IntentCreationResult> {
    return {
      intentId: this.nextPaymentIntentId,
      clientSecret: this.nextClientSecret,
      mode: "payment",
      amount: { value: opts.amount, currency: opts.currency },
    };
  }
  async createSetupIntent(_opts: SetupIntentOptions): Promise<IntentCreationResult> {
    return { intentId: "seti_shell", clientSecret: this.nextClientSecret, mode: "setup" };
  }
  async retrieveIntent(mode: StripeMode, id: string): Promise<StripeIntentView> {
    this.retrieveCalls.push({ mode, id });
    return this.retrieveResult ?? {
      id,
      status: "succeeded",
      mode,
      paymentMethod: { id: "pm_retrieved", brand: "visa", last4: "4242" },
    };
  }
  async cancelPaymentIntent(id: string): Promise<void> { this.cancelCalls.push(id); }
  verifyWebhook(): StripeEvent { throw new Error("not used"); }
}

function createFakeStripeJs() {
  const mountCalls: (HTMLElement | string)[] = [];
  const confirmCalls: { kind: "payment" | "setup"; opts: any }[] = [];
  let nextConfirmResult: any = null;
  const paymentElement: StripePaymentElementLike = {
    mount(target) { mountCalls.push(target); },
    unmount() {},
    destroy() {},
    on() {},
  };
  const elements: StripeElementsLike = {
    create() { return paymentElement; },
    getElement() { return paymentElement; },
  };
  const stripeJs: StripeJsLike = {
    elements: () => elements,
    async confirmPayment(opts) { confirmCalls.push({ kind: "payment", opts }); return nextConfirmResult ?? { paymentIntent: { id: "pi_shell", status: "succeeded" } }; },
    async confirmSetup(opts) { confirmCalls.push({ kind: "setup", opts }); return nextConfirmResult ?? { setupIntent: { id: "seti_shell", status: "succeeded" } }; },
  };
  return {
    stripeJs,
    mountCalls,
    confirmCalls,
    setConfirmResult: (r: any) => { nextConfirmResult = r; },
  };
}

if (!customElements.get("stripe-checkout-test")) {
  customElements.define("stripe-checkout-test", WcsStripe);
}

/**
 * Create and append a `<stripe-checkout-test>` with attrs pre-applied BEFORE
 * appendChild so connectedCallback sees them. Returns an element ready to
 * receive `attachLocalCore`.
 */
function createEl(attrs: Record<string, string> = {}): WcsStripe {
  const el = document.createElement("stripe-checkout-test") as WcsStripe;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

/** Reset the URL search. Used to control `_isPostRedirect` in tests. */
function setUrlSearch(search: string): void {
  history.replaceState(null, "", `${location.pathname}${search}`);
}

/**
 * Mock transport pair for remote-proxy integration tests. Mirrors the
 * `createMockTransportPair` helper from `@wc-bindable/remote`'s internal
 * tests: client.send enqueues a microtask on the server's handler and vice
 * versa, so the pair exercises real async message ordering without a
 * WebSocket.
 */
function createMockTransportPair(): { client: ClientTransport; server: ServerTransport } {
  let clientHandler: ((msg: ServerMessage) => void) | null = null;
  let serverHandler: ((msg: ClientMessage) => void) | null = null;
  const client: ClientTransport = {
    send: (msg) => { if (serverHandler) Promise.resolve().then(() => serverHandler!(msg)); },
    onMessage: (handler) => { clientHandler = handler; },
  };
  const server: ServerTransport = {
    send: (msg) => { if (clientHandler) Promise.resolve().then(() => clientHandler!(msg)); },
    onMessage: (handler) => { serverHandler = handler; },
  };
  return { client, server };
}

/** Flush a few microtask rounds so both directions of an async transport settle. */
async function flushTransport(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise(r => setTimeout(r, 0));
  }
}

describe("<stripe-checkout> Shell", () => {
  let el: WcsStripe;
  let provider: FakeProvider;
  let core: StripeCore;
  let fakes: ReturnType<typeof createFakeStripeJs>;

  beforeEach(() => {
    document.body.innerHTML = "";
    setUrlSearch("");
    provider = new FakeProvider();
    core = new StripeCore(provider, { webhookSecret: "whsec_test" });
    core.registerIntentBuilder(() => ({ mode: "payment", amount: 1980, currency: "jpy" }));
    fakes = createFakeStripeJs();
    WcsStripe.setLoader(async () => fakes.stripeJs);
  });

  afterEach(() => {
    setUrlSearch("");
    // SPEC §7.6 — test teardown discipline. `Stripe._loader` and
    // `Stripe._logger` are module-realm static state shared by every
    // `<stripe-checkout>` element in the same process. Without an
    // explicit reset, a loader / logger installed by one test leaks
    // into subsequent tests' setup phases (the `beforeEach` overwrite
    // of `setLoader` is unconditional, but any subsequent describe-
    // level test that builds its OWN loader-installer pattern would
    // miss the override, and the leaked logger is observed by any
    // cleanup path that touches `Stripe._logger`). Restoring the
    // defaults here makes the static-state invariant the doc demands
    // a property of the test suite itself, not a per-test contract.
    WcsStripe.resetLoader();
    WcsStripe.resetLogger();
  });

  it("declares a minimal public command surface (prepare/submit/reset/abort)", () => {
    const names = WcsStripe.wcBindable.commands!.map(c => c.name);
    expect(names).toEqual(["prepare", "submit", "reset", "abort"]);
    expect(names).not.toContain("requestIntent");
    expect(names).not.toContain("reportConfirmation");
    expect(names).not.toContain("resumeIntent");
  });

  describe("prepare() and auto-prepare on connect", () => {
    it("attachLocalCore triggers auto-prepare, mounting Elements", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // auto-prepare is fire-and-forget from attachLocalCore; await via prepare().
      await el.prepare();
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
      expect(el.intentId).toBe("pi_shell");
    });

    it("attachLocalCore injects the element as the Core's event target — status-changed bubbles to el listeners", async () => {
      // Regression: `_setStatus` / `_setLoading` / etc. dispatch on
      // `core._target`. Without target injection on attach, the target
      // defaults to the Core itself and `el.addEventListener("...:status-
      // changed", ...)` on the Shell never fires — UIs wired through the
      // standard Custom Element event surface would silently miss every
      // local-mode property update.
      const statusEvents: unknown[] = [];
      const intentIdEvents: unknown[] = [];
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.addEventListener("stripe-checkout:status-changed", (e) => statusEvents.push((e as CustomEvent).detail));
      el.addEventListener("stripe-checkout:intentId-changed", (e) => intentIdEvents.push((e as CustomEvent).detail));
      el.attachLocalCore(core);
      await el.prepare();
      // `processing` (intent create in flight) → `collecting` (mount done)
      expect(statusEvents).toContain("collecting");
      // `intentId-changed` should also have arrived on the element.
      expect(intentIdEvents).toContain("pi_shell");
    });

    it("disconnectedCallback restores the Core's original target (constructor-supplied, regression)", async () => {
      // Regression: `disconnectedCallback` used to always restore the
      // target to the Core itself, which was wrong for Cores built
      // with `new StripeCore(provider, { target: customSink })`. The
      // custom sink would be silently lost on detach. The fix
      // snapshots `core._getEventTarget()` at attachLocalCore time
      // and restores it on disconnect. Probe the routing by reading
      // `core._getEventTarget()` directly at each lifecycle point.
      const customSink = new EventTarget();
      const coreWithCustomSink = new StripeCore(provider, { target: customSink });
      coreWithCustomSink.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));

      // Pre-attach: target is the custom sink.
      expect(coreWithCustomSink._getEventTarget()).toBe(customSink);

      // Attach to a Shell. Target becomes the Shell.
      const localEl = createEl({ mode: "payment", "publishable-key": "pk_test_target_restore" });
      localEl.attachLocalCore(coreWithCustomSink);
      expect(coreWithCustomSink._getEventTarget()).toBe(localEl);

      // Detach. The custom sink MUST be restored. Without the fix,
      // target would have been restored to the Core itself.
      localEl.remove();
      expect(coreWithCustomSink._getEventTarget()).toBe(customSink);
    });

    it("disconnectedCallback restores to Core itself for default-target Cores (preserves prior behavior)", () => {
      // Cores built WITHOUT an explicit `target` option default to
      // `this` (the Core itself). Detach must restore to that
      // default — not silently switch to some other sink — so the
      // pre-attach default semantics are preserved for the
      // overwhelming majority of Cores constructed standalone.
      const standaloneCore = new StripeCore(provider);
      standaloneCore.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      // Pre-attach: target defaults to the Core itself.
      expect(standaloneCore._getEventTarget()).toBe(standaloneCore);

      const localEl = createEl({ mode: "payment", "publishable-key": "pk_test_default_target" });
      localEl.attachLocalCore(standaloneCore);
      expect(standaloneCore._getEventTarget()).toBe(localEl);

      localEl.remove();
      // Restored to the Core itself, matching the constructor default.
      expect(standaloneCore._getEventTarget()).toBe(standaloneCore);
    });

    it("attachLocalCore does NOT leave partial state when a Core setter throws (regression: bind ordering)", () => {
      // Regression: `attachLocalCore` previously bound the Shell as
      // the Core's `_target` AND assigned `this._core = core` BEFORE
      // pushing attributes into the Core's setters. If a Core input
      // setter (`core.mode = ...`, `core.amountValue = ...`, etc.)
      // threw synchronously, the Shell was left in a half-attached
      // state: `_target` rewired, `_core` assigned,
      // `_coreOriginalTarget` captured — but the input push aborted
      // mid-loop. Subsequent `disconnectedCallback` would then try
      // to clean up an attach that the caller observed as having
      // failed.
      //
      // The fix reorders: input push happens BEFORE the bind, so a
      // throw at the setter leaves the Core completely untouched
      // (`_target` not rewired, `_core` not assigned) — the caller
      // observes a clean rejection and the Shell stays free to
      // attach to a different Core.
      el = createEl({ mode: "payment", "publishable-key": "pk_test_attach_throw" });
      const standaloneCore = new StripeCore(provider);
      // Stub Core's `mode` setter to throw so we can drive the
      // partial-init path deterministically. The Shell pushes `mode`
      // first among the attrs, so this guarantees the throw fires
      // before any other setter touches the Core.
      Object.defineProperty(standaloneCore, "mode", {
        set: () => { throw new Error("synthetic mode setter throw"); },
        get: () => "payment",
        configurable: true,
      });

      expect(() => el.attachLocalCore(standaloneCore)).toThrow(/synthetic mode setter throw/);
      // Critical: NO partial state.
      //   - Core's target is still its constructor default (itself),
      //     NOT the Shell.
      //   - `this._core` is null, so `disconnectedCallback` has
      //     nothing to clean up.
      //   - `_coreOriginalTarget` is null (the snapshot only
      //     happens AFTER the input push completes).
      expect(standaloneCore._getEventTarget()).toBe(standaloneCore);
      expect((el as unknown as { _core: unknown })._core).toBeNull();
      expect((el as unknown as { _coreOriginalTarget: unknown })._coreOriginalTarget).toBeNull();
    });

    it("attachLocalCore rejects when a remote proxy is already attached", () => {
      // Mixing local + remote leaves observable getters reading from
      // different sources depending on path; fail loud at attach time.
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        expect(() => el.attachLocalCore(core)).toThrow(/remote Core proxy is attached/);
      } finally {
        shellProxy.dispose();
      }
    });

    it("_connectRemote rejects when a local Core is already attached", () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        expect(() => el._connectRemote(client)).toThrow(/local Core is attached/);
      } finally {
        shellProxy.dispose();
      }
    });

    it("disconnectedCallback survives reset() throwing on a disposed Core", () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // Dispose the Core while the element is still attached — a later
      // `disconnectedCallback` will reach `core.reset()` which throws on
      // disposed instances. The Custom Element detach lifecycle must not
      // bubble that throw out (would corrupt the parent DOM mutation).
      core.dispose();
      expect(() => document.body.removeChild(el)).not.toThrow();
    });

    it("prepare() is idempotent — concurrent callers share one in-flight promise", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      const p1 = el.prepare();
      const p2 = el.prepare();
      await Promise.all([p1, p2]);
      expect(fakes.mountCalls).toHaveLength(1);
    });

    it("sets prepared intent id on prepare and clears it on reset", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();
      expect((el as any)._preparedIntentId).toBe("pi_shell");

      el.reset();
      expect((el as any)._preparedIntentId).toBeNull();
    });

    it("prepare() without publishable-key throws", async () => {
      el = createEl({ mode: "payment" });
      el.attachLocalCore(core);
      await expect(el.prepare()).rejects.toThrow(/publishable-key is required/);
    });

    it("a failed prepare does not wedge — subsequent prepare retries", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      const original = provider.createPaymentIntent.bind(provider);
      // Use a Stripe-shaped error so the sanitizer's allowlist forwards
      // the message verbatim. A plain `new Error("stripe down")` would
      // collapse to "Payment failed." per SPEC §9.3 — covered by
      // stripeCore.test.ts's "redacts the message of a non-Stripe error"
      // suite — and the wedge-check below does not depend on the message.
      provider.createPaymentIntent = async () => {
        throw Object.assign(new Error("stripe down"), { type: "StripeAPIError" });
      };
      await expect(el.prepare()).rejects.toThrow(/stripe down/);
      provider.createPaymentIntent = original;
      await el.prepare();
      expect(fakes.mountCalls).toHaveLength(1);
    });

    it("auto-prepare fires when publishable-key is set AFTER connect + attach (regression: finding #1)", async () => {
      // Attrs set AFTER mount + attach: publishable-key is the LAST
      // prerequisite to land. SPEC says auto-prepare must still fire.
      // We deliberately do NOT call `el.prepare()` — if the auto path is
      // broken, the assertions below fail. An earlier version of this test
      // awaited prepare() as a "tick flush," which masked the regression.
      el = createEl({ mode: "payment" });  // no publishable-key yet
      el.attachLocalCore(core);
      expect(fakes.mountCalls).toHaveLength(0);
      el.setAttribute("publishable-key", "pk_test_123");
      // Let the fire-and-forget auto-prepare's microtask chain settle.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
      expect(el.intentId).toBe("pi_shell");
    });

    it("superseded prepare does not commit _preparedIntentId", async () => {
      // If a parked prepare is superseded (reset/abort/disconnect), late
      // requestIntent resolution must NOT commit the stale intent id.
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      const parked = (el as any)._preparePromise as Promise<void> | null;
      expect(parked).not.toBeNull();

      el.reset();
      releasePi({
        intentId: "pi_stale",
        clientSecret: "cs_stale",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });

      await parked!.catch(() => {});
      await new Promise(r => setTimeout(r, 0));

      expect((el as any)._preparedIntentId).toBeNull();
      expect(provider.cancelCalls).toContain("pi_stale");
    });

    it("publishable-key change invalidates cached Stripe.js (regression: key-cache bug)", async () => {
      // Instrument the loader to record the keys it was called with. The
      // bug was: first prepare() caches _stripeJs for pk_A; subsequent
      // prepare() after a key swap returned the pk_A-bound instance.
      const loaderCalls: string[] = [];
      WcsStripe.setLoader(async (key: string) => {
        loaderCalls.push(key);
        return fakes.stripeJs;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.attachLocalCore(core);
      await el.prepare();
      expect(loaderCalls).toEqual(["pk_A"]);

      el.reset();
      el.setAttribute("publishable-key", "pk_B");
      // Auto-prepare must re-fire and must build the NEW Stripe.js with pk_B.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(loaderCalls).toEqual(["pk_A", "pk_B"]);
    });

    it("publishable-key change cancels the orphan intent from the prior key", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.attachLocalCore(core);
      await el.prepare();
      const orphanId = el.intentId;
      expect(orphanId).toBe("pi_shell");

      el.setAttribute("publishable-key", "pk_B");
      // The orphan on the prior account must be cancelled server-side so
      // it does not linger billing nothing but leaking a row.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.cancelCalls).toContain(orphanId!);
    });

    it("loader race: key change DURING Stripe._loader(pk_A) discards the pk_A instance (regression)", async () => {
      // Two distinct Stripe.js fakes so we can verify which one actually
      // reaches `elements().mount(...)`. Prior bug: the loader race was
      // only closed at the CACHE seed — the stale instance was still
      // returned to the caller and used to mount Elements against the
      // new key's intent. The fix must ensure the pk_A instance never
      // reaches mount when the key flipped mid-load.
      const fakesA = createFakeStripeJs();
      const fakesB = createFakeStripeJs();

      const loaderCalls: string[] = [];
      let releasePkA!: (v: typeof fakesA.stripeJs) => void;
      const pkALoaderGate = new Promise<typeof fakesA.stripeJs>((resolve) => {
        releasePkA = resolve;
      });
      WcsStripe.setLoader(async (key: string) => {
        loaderCalls.push(key);
        if (key === "pk_A") return pkALoaderGate;  // stall
        return fakesB.stripeJs;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.attachLocalCore(core);

      // Drive microtasks until the auto-prepare has reached the stalled
      // pk_A loader. Two ticks: one for attachLocalCore → _maybeAutoPrepare
      // → prepare()'s sync setup + _requestIntent resolution; another for
      // _mountElements → _ensureStripeJs → await loader().
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(loaderCalls).toEqual(["pk_A"]);

      // Swap the key while the first loader is still stalled.
      el.setAttribute("publishable-key", "pk_B");

      // Release the stalled pk_A loader. If the fix is broken, the pk_A
      // instance flows into `_mountElements` and calls
      // `fakesA.stripeJs.elements(...).create(...).mount(...)`, which
      // would increment `fakesA.mountCalls`.
      releasePkA(fakesA.stripeJs);

      // Let the supersede-reject and the retry (auto-prepare with pk_B)
      // settle.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // The loader must have been called with both keys — pk_B's call is
      // the retry after the pk_A prepare was superseded.
      expect(loaderCalls).toEqual(["pk_A", "pk_B"]);
      // Crucially: pk_A's Stripe.js instance must NEVER have reached
      // mount. Only pk_B's mount path ran.
      expect(fakesA.mountCalls).toHaveLength(0);
      expect(fakesB.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
    });

    it("reset() during in-flight prepare (parked on _requestIntent) does NOT mount afterward (regression)", async () => {
      // Gate createPaymentIntent to simulate a slow network / server.
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // Let auto-prepare park on createPaymentIntent.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(fakes.mountCalls).toHaveLength(0);

      // reset() while prepare is parked.
      el.reset();

      // Release the stalled intent creation. The LATE result must NOT
      // drive Elements mount, re-seed _clientSecret, or set error state.
      releasePi({
        intentId: "pi_late_reset",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(el.status).toBe("idle");
      expect(el.intentId).toBeNull();
      expect(fakes.mountCalls).toHaveLength(0);
      expect(el.error).toBeNull();
    });

    it("abort() during in-flight prepare supersedes and cancels the orphan intent (regression)", async () => {
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      const abortPromise = el.abort();
      // Release the stalled intent creation AFTER abort() started so the
      // Core's own supersede path fires on the unblocked intent.
      releasePi({
        intentId: "pi_late_abort",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await abortPromise;
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      expect(el.status).toBe("idle");
      expect(fakes.mountCalls).toHaveLength(0);
      expect(el.error).toBeNull();
      // Orphan intent must be cancelled server-side so it does not
      // linger in requires_payment_method forever.
      expect(provider.cancelCalls).toContain("pi_late_abort");
    });

    it("disconnectedCallback during in-flight prepare does NOT mount into the detached element (regression)", async () => {
      let releasePi!: (v: IntentCreationResult) => void;
      provider.createPaymentIntent = () => new Promise<IntentCreationResult>((resolve) => {
        releasePi = resolve;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Remove the element from the DOM; disconnectedCallback fires sync.
      el.remove();

      releasePi({
        intentId: "pi_late_disc",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Critical: the stale prepare must NOT call elements/mount against
      // the detached element (would leak an orphan Stripe iframe).
      expect(fakes.mountCalls).toHaveLength(0);
    });

    it("user-abort supersede (reset) does NOT auto-retry (regression)", async () => {
      // Contract: reset() asks for terminal idle. The prepare cleanup
      // must NOT invoke `_maybeAutoPrepare` the way a key-change
      // supersede does — otherwise the element would silently re-mount
      // after every reset().
      let releasePi!: (v: IntentCreationResult) => void;
      let createCount = 0;
      provider.createPaymentIntent = () => {
        createCount++;
        return new Promise<IntentCreationResult>((resolve) => {
          releasePi = resolve;
        });
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(createCount).toBe(1);

      el.reset();
      releasePi({
        intentId: "pi_late_reset",
        clientSecret: "cs_late",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
      });
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // A key-change supersede would retry and call createPaymentIntent
      // a second time; reset must NOT do so.
      expect(createCount).toBe(1);
      expect(fakes.mountCalls).toHaveLength(0);
      expect(el.status).toBe("idle");
    });

    it("supersede-abort does NOT leak into observable error state (regression: contract guard)", async () => {
      // Supersede (key swapped mid-prepare) is a normal consequence of
      // user action, not a failure. The prepare() catch path has a
      // `gen === this._prepareGeneration` guard that skips _setErrorState
      // specifically for this case. This test pins that contract — if
      // someone removes the guard, supersede starts surfacing the
      // "publishable-key changed during Stripe.js load — aborting..."
      // internal error to el.error / core.error even though the
      // user-visible outcome is a successful retry.
      const fakesA = createFakeStripeJs();
      const fakesB = createFakeStripeJs();

      let releasePkA!: (v: typeof fakesA.stripeJs) => void;
      const pkALoaderGate = new Promise<typeof fakesA.stripeJs>((resolve) => {
        releasePkA = resolve;
      });
      WcsStripe.setLoader(async (key: string) => {
        if (key === "pk_A") return pkALoaderGate;
        return fakesB.stripeJs;
      });

      // Also capture `stripe-checkout:error` events; they must not fire with
      // a non-null detail for a supersede either.
      const errorEvents: unknown[] = [];

      el = createEl({ mode: "payment", "publishable-key": "pk_A" });
      el.addEventListener("stripe-checkout:error", (e) => errorEvents.push((e as CustomEvent).detail));
      el.attachLocalCore(core);

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      el.setAttribute("publishable-key", "pk_B");
      releasePkA(fakesA.stripeJs);

      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Successful retry happened.
      expect(el.status).toBe("collecting");
      // Observable error state is clean.
      expect(el.error).toBeNull();
      expect(core.error).toBeNull();
      // The only `stripe-checkout:error` dispatches should be null transitions
      // (from `_clearErrorState()` at the start of each prepare attempt);
      // none should carry a message mentioning the supersede.
      for (const detail of errorEvents) {
        if (detail && typeof detail === "object") {
          const msg = (detail as { message?: unknown }).message;
          if (typeof msg === "string") {
            expect(msg).not.toMatch(/supersed/i);
            expect(msg).not.toMatch(/publishable-key changed during/i);
          }
        }
      }
    });
  });

  describe("submit() confirms only", () => {
    beforeEach(() => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
    });

    it("single submit() transitions to succeeded", async () => {
      await el.prepare();
      await el.submit();
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(el.status).toBe("succeeded");
    });

    it("submit() auto-prepares when called before prepare()", async () => {
      // Do NOT call prepare() explicitly.
      await el.submit();
      expect(fakes.mountCalls).toHaveLength(1);
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(el.status).toBe("succeeded");
    });

    it("concurrent submit() calls dedupe into one confirm (regression: double-click)", async () => {
      // A rapid double-click (or two listeners both calling submit)
      // must fire confirmPayment exactly once. Without the guard, two
      // confirms for the same intent race and the later outcome
      // overwrites the earlier one on the Core — a card_declined
      // arriving after a succeeded would silently paint the UI
      // "failed" despite a real charge.
      await el.prepare();
      // Gate confirmPayment so both submit() calls are in flight
      // concurrently when the dedupe check runs.
      let release!: (v: unknown) => void;
      const originalConfirm = fakes.stripeJs.confirmPayment.bind(fakes.stripeJs);
      fakes.stripeJs.confirmPayment = ((opts: unknown) => {
        fakes.confirmCalls.push({ kind: "payment", opts });
        return new Promise((resolve) => { release = resolve; });
      }) as typeof fakes.stripeJs.confirmPayment;
      const p1 = el.submit();
      const p2 = el.submit();
      // Both callers observe the same in-flight submit promise.
      expect(p1).toBe(p2);
      // Let the single confirmPayment resolve.
      release({ paymentIntent: { id: "pi_shell", status: "succeeded" } });
      await Promise.all([p1, p2]);
      // Exactly ONE confirm went through despite two submit() callers.
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(el.status).toBe("succeeded");
      // After settlement, the next submit is a fresh call again.
      fakes.stripeJs.confirmPayment = originalConfirm;
    });

    it("surfaces confirm error and reports failure to Core", async () => {
      await el.prepare();
      fakes.setConfirmResult({ error: { code: "card_declined", message: "Declined." } });
      await el.submit();
      expect(el.status).toBe("failed");
      expect(el.error?.code).toBe("card_declined");
    });

    it("returnUrl setter accepts null/empty to clear the attribute (regression: input setter symmetry)", () => {
      // Symmetric with `amountValue` / `amountCurrency` / `customerId` /
      // `publishableKey`: `el.returnUrl = null` MUST remove the
      // attribute, not coerce to the string `"null"` (the prior shape
      // accepted `string` only and routed null through
      // `setAttribute("return-url", "null")`, leaving a value on the
      // DOM that fails Stripe.js's confirm-time scheme check with an
      // opaque diagnostic).
      el.setAttribute("return-url", "https://example.com/return");
      expect(el.getAttribute("return-url")).toBe("https://example.com/return");

      el.returnUrl = null as unknown as string; // Force the null path
      expect(el.hasAttribute("return-url")).toBe(false);
      expect(el.returnUrl).toBe("");

      el.returnUrl = "https://example.com/again";
      expect(el.getAttribute("return-url")).toBe("https://example.com/again");

      el.returnUrl = ""; // Empty string also clears
      expect(el.hasAttribute("return-url")).toBe(false);
    });

    it("_sanitizeStripeJsError drops non-taxonomy code / declineCode / type tokens (regression: Shell-side allowlist)", async () => {
      // Regression: `_sanitizeStripeJsError` previously forwarded `code`
      // / `decline_code` / `type` verbatim, on the assumption that
      // Stripe.js's confirm path produces a trustworthy shape. Browser
      // extensions / custom loaders / proxies can decorate the result
      // before it reaches the Shell, however — a forged
      // `code: "<script>"` / `type: "Card_Error"` could otherwise slip
      // into the `stripe-checkout:error` event detail. The fix gates
      // these fields through the same `_safeToken` / `_safeType`
      // allowlists used by `_setErrorStateFromUnknown`.
      //
      // Once `type` is dropped to undefined, the Core's downstream
      // `_sanitizeError` ALSO collapses `message` to "Payment failed."
      // because the error no longer looks Stripe-shaped — this is the
      // correct cascade behavior. The observable `el.error` (read via
      // `_core.error ?? this._errorState` in local mode) reflects the
      // Core's sanitized shape.
      await el.prepare();
      fakes.setConfirmResult({
        error: {
          code: "<script>alert(1)</script>",
          decline_code: "NOT-A-TAXONOMY-TOKEN!",
          type: "Card_Error",  // PascalCase variant that the regex deliberately rejects
          message: "Declined.",
        },
      });
      await el.submit();
      expect(el.status).toBe("failed");
      // Non-taxonomy `code` / `declineCode` / `type` dropped to undefined.
      expect(el.error?.code).toBeUndefined();
      expect(el.error?.declineCode).toBeUndefined();
      expect(el.error?.type).toBeUndefined();
      // `message` collapses to the generic Core-side fallback because
      // there is no Stripe-shaped `type` to vouch for the message
      // forwarding policy. This is the desired cascade — the forged
      // diagnostic text never makes it to the wire.
      expect(el.error?.message).toBe("Payment failed.");
    });

    it("_sanitizeStripeJsError preserves the original error when fields ARE valid taxonomy tokens", async () => {
      // Counterpart to the drop test above: a legitimate Stripe.js
      // error with all-lowercase `type: "card_error"` and a taxonomy-
      // compliant `code: "card_declined"` must flow through both
      // layers untouched. The previous test pins the negative path;
      // this one pins the positive path so the allowlist tightening
      // doesn't regress legitimate Stripe.js errors.
      await el.prepare();
      fakes.setConfirmResult({
        error: {
          code: "card_declined",
          decline_code: "insufficient_funds",
          type: "card_error",
          message: "Your card was declined.",
        },
      });
      await el.submit();
      expect(el.status).toBe("failed");
      expect(el.error?.code).toBe("card_declined");
      expect(el.error?.declineCode).toBe("insufficient_funds");
      expect(el.error?.type).toBe("card_error");
      expect(el.error?.message).toBe("Your card was declined.");
    });

    it("mode change after prepare does NOT redirect submit to the wrong confirm API (regression: finding #2)", async () => {
      await el.prepare(); // prepared mode = "payment"
      el.setAttribute("mode", "setup");
      await el.submit();
      // submit must dispatch confirmPayment (prepared mode), NOT
      // confirmSetup — the clientSecret is still a PaymentIntent secret,
      // so calling confirmSetup would be an unrecoverable mis-dispatch.
      expect(fakes.confirmCalls).toHaveLength(1);
      expect(fakes.confirmCalls[0].kind).toBe("payment");
    });

    it("mode change after prepare dispatches stripe-checkout:stale-config warning", async () => {
      const warnings: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:stale-config", (e) => warnings.push(e as CustomEvent));
      await el.prepare();
      el.setAttribute("mode", "setup");
      expect(warnings).toHaveLength(1);
      expect((warnings[0].detail as any).field).toBe("mode");
    });

    describe("abort() / reset() during in-flight confirm (regression)", () => {
      // Contract: once the user has asked to discard the attempt
      // (reset/abort) the late confirm outcome must not leak into observable
      // state. The user's intent is "terminate this flow" — a subsequent
      // `stripe-checkout:error` event, a populated `el.error`, or a status flip
      // to succeeded/failed would all contradict that. The Core already
      // drops stale `reportConfirmation` via its `_activeIntent == null`
      // guard, but the Shell's own `_errorState` / error event dispatch
      // path bypasses that guard and is what these tests pin down.
      /**
       * Swap `confirmPayment` for a gate that parks on a Promise until we
       * resolve it. Returns a `resolve(value)` function; awaiting it yields
       * a second-level resolver that releases the gated confirm with the
       * supplied mock result. Lets a test inject abort()/reset() AFTER
       * confirmPayment has actually been called but BEFORE it resolves.
       */
      function gateConfirm(): Promise<(v: unknown) => void> {
        return new Promise((resolveOuter) => {
          fakes.stripeJs.confirmPayment = ((opts: unknown) => {
            fakes.confirmCalls.push({ kind: "payment", opts });
            return new Promise((resolveInner) => resolveOuter(resolveInner));
          }) as typeof fakes.stripeJs.confirmPayment;
        });
      }

      it("abort() during in-flight confirm: late decline does not leak to error/status", async () => {
        await el.prepare();
        const gate = gateConfirm();
        const errorEvents: CustomEvent[] = [];
        el.addEventListener("stripe-checkout:error", (e) => errorEvents.push(e as CustomEvent));
        const submitP = el.submit();
        const release = await gate; // wait until confirmPayment is in flight
        const abortP = el.abort();
        // Stripe returns a decline AFTER abort has already cancelled pi_X
        // server-side. The Shell must not set `error` from this result.
        release({ error: { code: "card_declined", message: "Declined." } });
        await submitP;
        await abortP;
        expect(el.status).toBe("idle");
        expect(el.error).toBeNull();
        // No new error event from the post-abort confirm result.
        expect(errorEvents.filter(e => (e.detail as any)?.code === "card_declined")).toHaveLength(0);
        // The intent that was in flight is canceled server-side.
        expect(provider.cancelCalls).toContain("pi_shell");
      });

      it("abort() during in-flight confirm: late success does not flip status to succeeded", async () => {
        await el.prepare();
        const gate = gateConfirm();
        const submitP = el.submit();
        const release = await gate;
        const abortP = el.abort();
        release({ paymentIntent: { id: "pi_shell", status: "succeeded" } });
        await submitP;
        await abortP;
        // User asked to terminate — the in-flight confirm's succeeded result
        // must not paint observable state as succeeded. Best-effort cancel
        // was already issued server-side; if Stripe rejected it because the
        // charge went through, that is an edge case the app handles via
        // webhooks, not via a surprise "succeeded" in observable state.
        expect(el.status).toBe("idle");
        expect(el.error).toBeNull();
      });

      it("abort() during in-flight confirm that throws: error is swallowed, not surfaced", async () => {
        await el.prepare();
        const rejectGate: Promise<(e: unknown) => void> = new Promise((resolveOuter) => {
          fakes.stripeJs.confirmPayment = ((opts: unknown) => {
            fakes.confirmCalls.push({ kind: "payment", opts });
            return new Promise((_, rejectInner) => resolveOuter(rejectInner));
          }) as typeof fakes.stripeJs.confirmPayment;
        });
        const submitP = el.submit().catch(() => { /* user-initiated abort swallows */ });
        const reject = await rejectGate;
        const abortP = el.abort();
        reject(new Error("network flaked mid-confirm"));
        await submitP;
        await abortP;
        expect(el.status).toBe("idle");
        expect(el.error).toBeNull();
      });

      it("reset() during in-flight confirm: late decline does not leak to error/status", async () => {
        await el.prepare();
        const gate = gateConfirm();
        const errorEvents: CustomEvent[] = [];
        el.addEventListener("stripe-checkout:error", (e) => errorEvents.push(e as CustomEvent));
        const submitP = el.submit();
        const release = await gate;
        el.reset();
        release({ error: { code: "card_declined", message: "Declined." } });
        await submitP;
        expect(el.status).toBe("idle");
        expect(el.error).toBeNull();
        expect(errorEvents.filter(e => (e.detail as any)?.code === "card_declined")).toHaveLength(0);
      });

      it("reset() during in-flight confirm: terminal paymentIntent status (requires_payment_method) does not leak", async () => {
        // _applyIntentOutcome's requires_payment_method branch calls
        // `_setErrorState(err)` directly — separate leak path from the
        // result.error branch above. Pin it down explicitly.
        await el.prepare();
        const gate = gateConfirm();
        const submitP = el.submit();
        const release = await gate;
        el.reset();
        release({
          paymentIntent: {
            id: "pi_shell",
            status: "requires_payment_method",
            last_payment_error: { code: "card_declined", message: "Declined." },
          },
        });
        await submitP;
        expect(el.status).toBe("idle");
        expect(el.error).toBeNull();
      });
    });

    it("submit() with a stale prepare promise that resolves AFTER a user-abort gen bump fails loud with submit_superseded (regression)", async () => {
      // Contract guard for the pre-enter generation snapshot in
      // `_submitImpl`: when submit() awaits a prepare promise that
      // resolves AFTER a user-abort supersede has bumped the generation
      // (reset / abort / disconnect interleaving with submit's await),
      // the auto-prepare fallback below MUST NOT silently create a fresh
      // PaymentIntent. That would bypass the user's abort and reopen a
      // duplicate-charge surface. submit() must reject loud with
      // `code: "submit_superseded"`.
      //
      // Driving the natural race (gated provider + reset() between
      // submit's `if (this._preparePromise)` and its `await`) is brittle
      // because the prepare's own supersede checks normally turn it into
      // a rejection. Pin the contract by INJECTING a `_preparePromise`
      // that bumps the generation when awaited — exactly the
      // observable shape "prepare resolved while submit was parked, but
      // a user-abort landed in the same microtask round."
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // Let any auto-prepare from attachLocalCore settle first so we can
      // overwrite `_preparePromise` cleanly.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      const priv = el as unknown as {
        _preparePromise: Promise<void> | null;
        _prepareGeneration: number;
        _supersedeIsUserAbort: boolean;
        _markSupersede: (userAbort: boolean) => void;
      };

      // A staged promise that, on `await`, advances the generation as if
      // a reset()/abort() landed during submit's wait. By the time
      // submit's continuation runs the gen-check, `_prepareGeneration`
      // has moved past `preEnterGen` AND `_supersedeIsUserAbort = true`.
      const stagedPrepare = Promise.resolve().then(() => {
        priv._markSupersede(true);
      });
      priv._preparePromise = stagedPrepare;

      const errorEvents: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:error", (e) => errorEvents.push(e as CustomEvent));

      await expect(el.submit()).rejects.toThrow(/submit\(\) superseded/);

      // Local error state surfaces the dedicated code.
      expect(el.error?.code).toBe("submit_superseded");
      // The error was observable as a `stripe-checkout:error` event too.
      const errorWithCode = errorEvents
        .map(e => e.detail as { code?: string } | null)
        .find(d => d?.code === "submit_superseded");
      expect(errorWithCode).toBeDefined();
      // No confirm was attempted.
      expect(fakes.confirmCalls).toHaveLength(0);
    });

    it("submit() with a CONFIG-change supersede during the prepare wait falls through to auto-prepare (regression)", async () => {
      // Symmetry guard for the previous test: a config-change supersede
      // (`_supersedeIsUserAbort = false`, set by `_invalidateForKeyChange`)
      // schedules its OWN auto-prepare from the cleanup, so submit() must
      // NOT fail loud — it should fall through to the auto-prepare branch
      // and end up confirming on the freshly built intent. Without the
      // `_supersedeIsUserAbort` qualifier on the gen-check, a key swap
      // mid-prepare would produce spurious submit_superseded errors.
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      const priv = el as unknown as {
        _preparePromise: Promise<void> | null;
        _markSupersede: (userAbort: boolean) => void;
      };

      // Prepare resolves with a CONFIG-flavor supersede mid-await.
      const stagedPrepare = Promise.resolve().then(() => {
        priv._markSupersede(false); // config-change supersede
      });
      priv._preparePromise = stagedPrepare;

      // submit() falls through to auto-prepare and confirms. Should NOT
      // surface submit_superseded.
      await el.submit();
      expect(el.error).toBeNull();
      expect(fakes.confirmCalls).toHaveLength(1);
    });

    it("reset() + re-prepare lets mode change take effect", async () => {
      // Rebuild the core with a mode-responsive builder so switching modes
      // between prepares is legal (the default builder only returns payment).
      document.body.innerHTML = "";
      const flexCore = new StripeCore(provider, { webhookSecret: "whsec_test" });
      flexCore.registerIntentBuilder((req) => req.mode === "setup"
        ? { mode: "setup" }
        : { mode: "payment", amount: 1980, currency: "jpy" });
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(flexCore);

      await el.prepare(); // payment
      el.reset();
      el.setAttribute("mode", "setup");
      await el.prepare();
      await el.submit();
      // The most recent confirm must be setup now that we re-prepared.
      expect(fakes.confirmCalls[fakes.confirmCalls.length - 1].kind).toBe("setup");
    });
  });

  describe("3DS redirect resume (regression: findings #1 + URL authorization)", () => {
    it("rebuilds Core state from URL when intent_id AND client_secret are both present and match", async () => {
      setUrlSearch("?payment_intent=pi_resumed&payment_intent_client_secret=pi_resumed_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_resumed",
        status: "succeeded",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
        paymentMethod: { id: "pm_z", brand: "mastercard", last4: "5555" },
        clientSecret: "pi_resumed_secret_ok",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resumed" }]);
      expect(el.status).toBe("succeeded");
      expect(el.intentId).toBe("pi_resumed");
      expect(el.paymentMethod).toEqual({ id: "pm_z", brand: "mastercard", last4: "5555" });
      // Auto-prepare must NOT have created a second intent alongside the resumed one.
      expect(fakes.mountCalls).toHaveLength(0);
    });

    it("URL redirect params are stripped after resume, and subsequent prepare() proceeds (regression)", async () => {
      setUrlSearch("?payment_intent=pi_resumed&payment_intent_client_secret=pi_resumed_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_resumed",
        status: "succeeded",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
        paymentMethod: { id: "pm_z", brand: "mastercard", last4: "5555" },
        clientSecret: "pi_resumed_secret_ok",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(el.status).toBe("succeeded");

      // Stripe's redirect params must be gone from the URL so a reload /
      // share / back-button does not re-trigger resume.
      const params = new URLSearchParams(globalThis.location.search);
      expect(params.has("payment_intent")).toBe(false);
      expect(params.has("payment_intent_client_secret")).toBe(false);
      expect(params.has("redirect_status")).toBe(false);

      // User clicks "pay again" on the completion page. reset() +
      // prepare() must proceed — previously the stale URL kept
      // `_isPostRedirect()` latched true forever.
      el.reset();
      await el.prepare();
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.status).toBe("collecting");
      expect(el.intentId).toBe("pi_shell");
    });

    it("prepare() is still unblocked when URL cleanup is suppressed (history.replaceState sandboxed)", async () => {
      // Simulate a sandbox where replaceState is a no-op. Verify the
      // `_resumed` fallback gate in `_isPostRedirect()` still lets
      // subsequent prepare() / reset() go through even though the URL
      // cleanup could not run.
      setUrlSearch("?payment_intent=pi_resumed2&payment_intent_client_secret=pi_resumed2_secret_ok");
      const originalReplaceState = history.replaceState.bind(history);
      // Stub AFTER setUrlSearch so the URL actually carries the params
      // when the test starts. During the test, stubbed replaceState
      // leaves the URL alone.
      history.replaceState = () => { /* sandboxed no-op */ };

      try {
        provider.retrieveResult = {
          id: "pi_resumed2",
          status: "succeeded",
          mode: "payment",
          clientSecret: "pi_resumed2_secret_ok",
        };
        el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
        el.attachLocalCore(core);
        await new Promise(r => setTimeout(r, 0));
        await new Promise(r => setTimeout(r, 0));
        expect(el.status).toBe("succeeded");
        // URL params were NOT stripped (replaceState was a no-op).
        expect(globalThis.location.search).toContain("payment_intent=pi_resumed2");

        // A new prepare() must still proceed because `_resumed` overrides
        // the URL-based branch of `_isPostRedirect()`.
        el.reset();
        await el.prepare();
        expect(fakes.mountCalls).toHaveLength(1);
      } finally {
        history.replaceState = originalReplaceState;
      }
    });

    it("disconnect during in-flight resume does NOT let the resume's finally re-latch _resumed=true (regression)", async () => {
      // Regression: `_resumeFromRedirect`'s finally block re-latched
      // `_resumed = true` even after `disconnectedCallback` had
      // explicitly cleared it via `_markSupersede(true)`. A
      // portal/teleport that does `el.remove()` mid-resume would
      // therefore see `_resumed = true` re-stamped, silently wedging
      // the next mount's `_isPostRedirect()` check and dropping any
      // fresh 3DS URL on the floor. The fix snapshots `_prepareGeneration`
      // before the await and only writes back if the snapshot is still
      // current at finally time.
      setUrlSearch("?payment_intent=pi_race&payment_intent_client_secret=pi_race_secret_ok");
      // Park the provider retrieve in a manual-release promise so we
      // can interleave a disconnect before it resolves.
      let releaseRetrieve!: () => void;
      const retrievePromise = new Promise<void>(r => { releaseRetrieve = r; });
      const origRetrieve = provider.retrieveIntent.bind(provider);
      provider.retrieveIntent = async (mode, id) => {
        await retrievePromise;
        return origRetrieve(mode, id);
      };
      provider.retrieveResult = {
        id: "pi_race",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_race_secret_ok",
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      // Give microtask queue a tick so `_resumeFromRedirect` reaches its
      // `await _coreResume` (which awaits `await provider.retrieveIntent`).
      await new Promise(r => setTimeout(r, 0));
      expect((el as unknown as { _resuming: boolean })._resuming).toBe(true);

      // Detach the element mid-resume. `_markSupersede(true)` bumps
      // `_prepareGeneration` and `disconnectedCallback` clears `_resumed`
      // to false.
      el.remove();
      expect((el as unknown as { _resumed: boolean })._resumed).toBe(false);

      // Now let the parked retrieve resolve — `_resumeFromRedirect`'s
      // finally will fire. Without the generation guard, it would
      // re-latch `_resumed = true`. With the fix, the generation
      // mismatch suppresses the write.
      releaseRetrieve();
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Critical assertion: `_resumed` STAYS false. Even though the
      // resume's coroutine ran to completion server-side (the
      // retrieve resolved), the Shell's local lifecycle was superseded
      // by the disconnect, so the URL-strip + `_resumed = true` latch
      // MUST be skipped.
      expect((el as unknown as { _resumed: boolean })._resumed).toBe(false);

      provider.retrieveIntent = origRetrieve;
    });

    it("Stripe-taxonomy code (e.g. resource_missing) is classified as decisive, strips URL, prevents infinite retry (regression)", async () => {
      // Regression: the local-mode "decisive vs transient" classifier
      // previously only accepted the two Core-internal codes
      // ("resume_client_secret_mismatch" / "resume_not_authorized")
      // as decisive. A Stripe-API-side failure like 404
      // "resource_missing" (tampered intent id, intent already
      // cancelled at Stripe, …) carries `code: "resource_missing"`
      // which fell into the transient bucket — the URL was NOT
      // stripped, `_resumed` stayed false, the next connect re-fired
      // resume against the same broken id, ad infinitum. The fix
      // classifies any error whose `code` matches the Stripe
      // taxonomy regex (`STRIPE_ERROR_CODE_RE`) as decisive too.
      setUrlSearch("?payment_intent=pi_404&payment_intent_client_secret=pi_404_secret_xx");
      // Provider throws a Stripe-shaped 404 (the sanitizer forwards
      // `code: "resource_missing"` because the error has a valid
      // Stripe type).
      provider.retrieveIntent = async () => {
        throw Object.assign(new Error("No such payment_intent: pi_404"), {
          code: "resource_missing",
          type: "invalid_request_error",
        });
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_resource_missing" });
      el.addEventListener("error", () => {}); // swallow
      el.attachLocalCore(core);
      // Let resume run.
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // Critical: `_resumed` MUST flip to true (decisive denial), and
      // the URL params MUST be stripped — otherwise the next connect
      // would loop forever on the same dead id.
      expect((el as unknown as { _resumed: boolean })._resumed).toBe(true);
      expect(globalThis.location.search).not.toContain("payment_intent=pi_404");
    });

    it("non-Stripe-shape transport failure stays transient, URL preserved for retry", async () => {
      // Counterpart to the regression above: a plain non-Stripe-shaped
      // throw (no `code`, no Stripe `type`) is still treated as
      // transient. This pins the boundary between "definitive
      // application-level denial" (decisive) and "the network
      // couldn't be reached" (transient).
      setUrlSearch("?payment_intent=pi_transient&payment_intent_client_secret=pi_transient_secret_xx");
      provider.retrieveIntent = async () => {
        throw new Error("ECONNREFUSED"); // plain Error, no code / type
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_transient" });
      el.addEventListener("error", () => {});
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // `_resumed` must STAY false so a later trigger (reconnect /
      // reload) retries with the URL intact.
      expect((el as unknown as { _resumed: boolean })._resumed).toBe(false);
      expect(globalThis.location.search).toContain("payment_intent=pi_transient");
    });

    it("disconnect → reconnect clears _resumed so a same-instance remount can resume a fresh redirect URL", async () => {
      // Regression: the class JSDoc on `_resumed` promised that
      // `disconnectedCallback → connectedCallback` is a session reset
      // boundary, but the flag was previously only cleared on
      // _instance_ replacement, not on detach. A framework portal /
      // teleport that moves the SAME element between containers would
      // therefore keep `_resumed = true` from a prior page load and
      // refuse to fire `_resumeFromRedirect` on the second mount —
      // silently dropping a fresh 3DS redirect into auto-prepare-blocked
      // limbo.
      //
      // First resume: succeeds, latches `_resumed = true`.
      setUrlSearch("?payment_intent=pi_first&payment_intent_client_secret=pi_first_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_first",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_first_secret_ok",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(el.status).toBe("succeeded");
      expect(provider.retrieveCalls).toHaveLength(1);

      // Detach the SAME element instance.
      el.remove();

      // A different 3DS redirect arrives between mounts.
      setUrlSearch("?payment_intent=pi_second&payment_intent_client_secret=pi_second_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_second",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_second_secret_ok",
      };
      // Re-attach a fresh Core (the prior Core was reset+detached).
      const { core: core2 } = await import("../src/core/StripeCore").then(m => ({ core: new m.StripeCore(provider) }));
      core2.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));

      document.body.appendChild(el);
      el.attachLocalCore(core2);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      // Second resume MUST have fired — the provider retrieve was called
      // for pi_second (not just pi_first from the prior mount).
      expect(provider.retrieveCalls).toHaveLength(2);
      expect(provider.retrieveCalls[1]).toEqual({ mode: "payment", id: "pi_second" });
      expect(el.intentId).toBe("pi_second");
    });

    it("resume detects setup_intent and uses setup mode", async () => {
      setUrlSearch("?setup_intent=seti_resumed&setup_intent_client_secret=seti_resumed_secret_ok");
      provider.retrieveResult = {
        id: "seti_resumed",
        status: "succeeded",
        mode: "setup",
        paymentMethod: { id: "pm_a", brand: "visa", last4: "1111" },
        clientSecret: "seti_resumed_secret_ok",
      };
      el = createEl({ mode: "setup", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.retrieveCalls).toEqual([{ mode: "setup", id: "seti_resumed" }]);
      expect(el.status).toBe("succeeded");
    });

    it("when both redirect tuples are present, resume deterministically prefers payment", async () => {
      setUrlSearch(
        "?payment_intent=pi_both&payment_intent_client_secret=pi_both_secret_ok&setup_intent=seti_both&setup_intent_client_secret=seti_both_secret_ok"
      );
      provider.retrieveResult = {
        id: "pi_both",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_both_secret_ok",
      };
      // URL redirect tuple decides resume mode; element `mode` attribute is ignored here.
      el = createEl({ mode: "setup", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_both" }]);
      expect(el.intentId).toBe("pi_both");
    });

    it("rejects a foreign intent id when the client_secret does not match (permission-bypass regression)", async () => {
      // Attacker constructs a URL with a valid victim intent id but a
      // guessed/forged client_secret. Stripe retrieves the real intent,
      // but the ownership check rejects.
      setUrlSearch("?payment_intent=pi_victim&payment_intent_client_secret=pi_victim_secret_GUESSED");
      provider.retrieveResult = {
        id: "pi_victim",
        status: "succeeded",
        mode: "payment",
        amount: { value: 9999, currency: "usd" },
        paymentMethod: { id: "pm_v", brand: "visa", last4: "0000" },
        clientSecret: "pi_victim_secret_REAL",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));
      // State must NOT hydrate the victim's intent.
      expect(el.status).not.toBe("succeeded");
      expect(el.intentId).toBeNull();
      expect(el.paymentMethod).toBeNull();
      expect(el.error?.code).toBe("resume_client_secret_mismatch");
      // And the attacker cannot cancel via abort() — no active intent.
      const cancelBefore = provider.cancelCalls.length;
      await el.abort();
      expect(provider.cancelCalls.length).toBe(cancelBefore);
    });

    it("URL with intent_id but NO client_secret is treated as not-a-redirect (auto-prepare still runs)", async () => {
      // A hand-crafted/tampered URL. Since the secret is missing, the
      // Shell does not kick off resume — it falls through to normal
      // auto-prepare, which creates a fresh intent.
      setUrlSearch("?payment_intent=pi_hand_crafted");
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();  // auto-prepare runs normally
      expect(provider.retrieveCalls).toHaveLength(0);
      expect(fakes.mountCalls).toHaveLength(1);
      expect(el.intentId).toBe("pi_shell");  // fresh intent from the builder
    });
  });

  describe("non-exposure invariant", () => {
    it("does NOT expose clientSecret through any element property or attribute", async () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();
      const secret = provider.nextClientSecret;
      const props: Record<string, unknown> = {
        status: el.status,
        loading: el.loading,
        amount: el.amount,
        paymentMethod: el.paymentMethod,
        intentId: el.intentId,
        error: el.error,
      };
      for (const [, v] of Object.entries(props)) {
        expect(JSON.stringify(v)).not.toContain(secret);
      }
      for (const attr of el.getAttributeNames()) {
        expect(el.getAttribute(attr) ?? "").not.toContain(secret);
      }
      for (const k of Object.keys(el.dataset)) {
        expect((el.dataset as any)[k]).not.toContain(secret);
      }
      expect(Object.keys(el as any)).not.toContain("clientSecret");
    });
  });

  describe("remote proxy integration", () => {
    // These tests exercise the `_connectRemote` path end-to-end through an
    // in-memory transport pair + RemoteShellProxy + a real StripeCore, the
    // same wiring a WebSocket deployment uses — just without the socket.
    // The `attachLocalCore` path is covered elsewhere; this block pins the
    // behaviors that only show up once Core events have to cross the wire
    // (initial `sync`, `setWithAck` ordering, `invoke` + update interleave).

    it("remote disconnect teardown waits in-flight prepare before reset/dispose", async () => {
      el = createEl({ mode: "payment" });
      const order: string[] = [];
      let releasePrepare!: () => void;
      const parkedPrepare = new Promise<void>((resolve) => { releasePrepare = resolve; });

      const proxy = {
        invoke: async (name: string) => { order.push(`invoke:${name}`); },
        invokeWithOptions: async (name: string) => { order.push(`invokeWithOptions:${name}`); },
        dispose: () => { order.push("dispose"); },
      } as unknown as { invoke: (n: string) => Promise<void>; invokeWithOptions: (n: string) => Promise<void>; dispose: () => void };

      (el as unknown as { _proxy: unknown })._proxy = proxy;
      (el as unknown as { _preparePromise: Promise<void> | null })._preparePromise = parkedPrepare;
      (el as unknown as { _unbind: (() => void) | null })._unbind = () => { order.push("unbind"); };
      (el as unknown as { _ws: { close: () => void } | null })._ws = { close: () => { order.push("ws.close"); } };

      el.remove();

      // Sync detach: new sessions can start immediately.
      expect((el as unknown as { _proxy: unknown })._proxy).toBeNull();
      expect(order).toEqual([]);

      releasePrepare();
      await flushTransport(4);

      expect(order[0]).toBe("invoke:reset");
      expect(order.indexOf("invoke:reset")).toBeLessThan(order.indexOf("unbind"));
      expect(order.indexOf("unbind")).toBeLessThan(order.indexOf("dispose"));
      expect(order.indexOf("dispose")).toBeLessThan(order.indexOf("ws.close"));
    });

    it("remote disconnect nulls _proxy synchronously (rapid reconnect precondition)", async () => {
      el = createEl({ mode: "payment" });
      (el as unknown as { _proxy: unknown })._proxy = {
        invoke: async () => {},
        invokeWithOptions: async () => {},
        dispose: () => {},
      };
      expect((el as unknown as { _isRemote: boolean })._isRemote).toBe(true);
      el.remove();
      expect((el as unknown as { _proxy: unknown })._proxy).toBeNull();
      expect((el as unknown as { _isRemote: boolean })._isRemote).toBe(false);
      await flushTransport(2);
    });

    it("remote disconnect cleanup stays scoped to captured old proxy", async () => {
      el = createEl({ mode: "payment" });
      const oldCalls: string[] = [];
      const newCalls: string[] = [];

      let releasePrepare!: () => void;
      const parkedPrepare = new Promise<void>((resolve) => { releasePrepare = resolve; });

      const oldProxy = {
        invoke: async (name: string) => { oldCalls.push(`invoke:${name}`); },
        invokeWithOptions: async (name: string) => { oldCalls.push(`invokeWithOptions:${name}`); },
        dispose: () => { oldCalls.push("dispose"); },
      };
      const newProxy = {
        invoke: async (name: string) => { newCalls.push(`invoke:${name}`); },
        invokeWithOptions: async (name: string) => { newCalls.push(`invokeWithOptions:${name}`); },
        dispose: () => { newCalls.push("dispose"); },
      };

      (el as unknown as { _proxy: unknown })._proxy = oldProxy;
      (el as unknown as { _preparePromise: Promise<void> | null })._preparePromise = parkedPrepare;
      (el as unknown as { _unbind: (() => void) | null })._unbind = () => { oldCalls.push("unbind"); };
      (el as unknown as { _ws: { close: () => void } | null })._ws = { close: () => { oldCalls.push("ws.close"); } };

      el.remove();
      // Simulate rapid reconnect attaching a different session object.
      (el as unknown as { _proxy: unknown })._proxy = newProxy;

      releasePrepare();
      await flushTransport(4);

      expect(oldCalls).toContain("invoke:reset");
      expect(oldCalls).toContain("dispose");
      expect(newCalls).toHaveLength(0);
    });

    it("remote disconnect proactively cancels known orphan intent via captured proxy", async () => {
      el = createEl({ mode: "payment" });
      const calls: Array<{ name: string; args: unknown[] }> = [];
      const proxy = {
        invoke: async (name: string) => { calls.push({ name, args: [] }); },
        invokeWithOptions: async (name: string, args: unknown[]) => {
          calls.push({ name, args });
        },
        dispose: () => {},
      };

      (el as unknown as { _proxy: unknown })._proxy = proxy;
      (el as unknown as { _remoteValues: Record<string, unknown> })._remoteValues = {
        intentId: "pi_orphan_disconnect",
      };
      (el as unknown as { _unbind: (() => void) | null })._unbind = () => {};
      (el as unknown as { _ws: { close: () => void } | null })._ws = { close: () => {} };

      el.remove();
      await flushTransport(4);

      const cancelIdx = calls.findIndex(c => c.name === "cancelIntent");
      const resetIdx = calls.findIndex(c => c.name === "reset");
      expect(cancelIdx).toBeGreaterThanOrEqual(0);
      expect(resetIdx).toBeGreaterThanOrEqual(0);
      expect(cancelIdx).toBeLessThan(resetIdx);
      expect(calls[cancelIdx].args[0]).toBe("pi_orphan_disconnect");
    });

    it("connect-time input sync: declarative attrs reach the Core via setWithAck", async () => {
      // Deliberately omit publishable-key so auto-prepare bails — the test
      // isolates the input-sync path without an intent-creation round-trip
      // fighting for the same microtask queue.
      el = createEl({
        mode: "setup",
        "amount-value": "500",
        "amount-currency": "usd",
        "customer-id": "cus_remote_1",
      });

      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        await flushTransport();

        // Inputs declared on the element landed on the server-side Core.
        expect(core.mode).toBe("setup");
        expect(core.amountValue).toBe(500);
        expect(core.amountCurrency).toBe("usd");
        expect(core.customerId).toBe("cus_remote_1");

        // Initial sync delivered server state to the client; the element
        // reads remote-cached values via its getters.
        expect(el.status).toBe("idle");
        expect(el.loading).toBe(false);
        expect(el.intentId).toBeNull();

        // No intent was created — auto-prepare bailed (no publishable-key).
        expect(fakes.mountCalls).toHaveLength(0);
      } finally {
        shellProxy.dispose();
      }
    });

    it("connect-time sync ignores unset attrs — Core inputs keep their defaults", async () => {
      // Only some attrs are present; unset attrs must NOT be forwarded as
      // setWithAck calls. Regression guard: `hasAttribute` (not truthiness)
      // decides whether to forward, so an attribute that never existed
      // leaves the Core-side default untouched.
      core.amountValue = 9999; // pre-existing Core-side default
      core.customerId = "cus_preexisting";

      el = createEl({ mode: "payment" }); // only `mode` is set

      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        await flushTransport();

        expect(core.mode).toBe("payment");
        // Unset attrs must not have overwritten pre-existing Core state.
        expect(core.amountValue).toBe(9999);
        expect(core.customerId).toBe("cus_preexisting");
      } finally {
        shellProxy.dispose();
      }
    });

    it("post-redirect resume: cmd → retrieveIntent → update fold back to the element", async () => {
      // Simulate a 3DS return: URL carries the intent id and Stripe's
      // client_secret; the element autofires resumeIntent over the wire on
      // _connectRemote. The server-side Core retrieves and hydrates state;
      // its update messages must drive `el.status` / `el.intentId` over
      // the remote boundary without any call to attachLocalCore.
      setUrlSearch("?payment_intent=pi_remote_resume&payment_intent_client_secret=pi_remote_resume_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_remote_resume",
        status: "succeeded",
        mode: "payment",
        amount: { value: 2500, currency: "usd" },
        paymentMethod: { id: "pm_remote", brand: "visa", last4: "4242" },
        clientSecret: "pi_remote_resume_secret_ok",
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_remote" });
      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        // Resume is an async cmd over the transport; give it enough rounds
        // for: sync, cmd dispatch, retrieveIntent, update(intentId), update
        // (paymentMethod), update(amount), update(status), return.
        await flushTransport(8);

        // Core actually ran resumeIntent for the URL's intent.
        expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_remote_resume" }]);
        // Shell observable state hydrated over the wire — no mount, no
        // second intent alongside the resumed one.
        expect(el.status).toBe("succeeded");
        expect(el.intentId).toBe("pi_remote_resume");
        expect(el.amount).toEqual({ value: 2500, currency: "usd" });
        expect(el.paymentMethod).toEqual({ id: "pm_remote", brand: "visa", last4: "4242" });
        expect(fakes.mountCalls).toHaveLength(0);

        // Redirect params must be stripped so a reload / share does not
        // re-trigger resume — same contract as the local-Core path.
        const params = new URLSearchParams(globalThis.location.search);
        expect(params.has("payment_intent")).toBe(false);
        expect(params.has("payment_intent_client_secret")).toBe(false);
      } finally {
        shellProxy.dispose();
      }
    });

    it("transport-side resume failure preserves URL params + _resumed so retry is possible (regression: 3DS duplicate-charge exposure)", async () => {
      // The Core never sees this resume — transport rejects the cmd. The
      // element must NOT mark the 3DS return "consumed": that would strip
      // the URL and latch `_resumed = true`, blocking any subsequent
      // retry and forcing a fresh intent for the same cart. Real risk:
      // the 3DS flow already cleared at Stripe, so creating a NEW intent
      // can lead to double-charging, while the user sees "failed" despite
      // the underlying charge going through.
      setUrlSearch("?payment_intent=pi_ws_resume&payment_intent_client_secret=pi_ws_resume_secret_ok&redirect_status=succeeded");
      provider.retrieveResult = {
        id: "pi_ws_resume",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_ws_resume_secret_ok",
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_ws" });
      const { client: realClient, server } = createMockTransportPair();
      // Transport that refuses every cmd — Core never receives the
      // resumeIntent invocation.
      const deadClient: ClientTransport = {
        send: (msg) => {
          if (msg.type === "cmd") throw new Error("transport closed");
          realClient.send(msg);
        },
        onMessage: (handler) => realClient.onMessage(handler),
      };
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(deadClient);
        await flushTransport(6);

        // Core DID NOT run the resume (transport ate the cmd).
        expect(provider.retrieveCalls).toHaveLength(0);

        // URL params must still be present so a later retry (reload,
        // re-connect) can re-read them.
        const params = new URLSearchParams(globalThis.location.search);
        expect(params.has("payment_intent")).toBe(true);
        expect(params.has("payment_intent_client_secret")).toBe(true);

        // A fresh connect on a recovered transport must re-attempt the
        // resume — not fall through to auto-prepare for a new intent.
        // Simulate reconnect by disposing the dead proxy + attaching
        // a fresh working pair. Re-using the same element instance is
        // what a WS-recovery flow would do.
        (el as unknown as { _disposeRemote: () => void })._disposeRemote();
        const recovered = createMockTransportPair();
        const recoveredProxy = new RemoteShellProxy(core, recovered.server);
        try {
          (el as unknown as { _connectRemote: (t: ClientTransport) => void })._connectRemote(recovered.client);
          await flushTransport(8);
          // Resume retried and Core now ran the retrieve.
          expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_ws_resume" }]);
          expect(el.status).toBe("succeeded");
          expect(el.intentId).toBe("pi_ws_resume");
        } finally {
          recoveredProxy.dispose();
        }
      } finally {
        shellProxy.dispose();
      }
    });

    it("transport-only resume failure with STALE remote error keeps URL retriable (seq-based coreSpoke regression)", async () => {
      // The coarse `!!this._remoteValues.error` check would misclassify
      // this scenario as a Core-origin rejection: the session already
      // holds a truthy `_remoteValues.error` from a prior operation, so
      // even though the resume cmd never reached the Core, the Shell
      // would strip the URL and latch `_resumed = true`. The seq-based
      // check must gate on whether an error update crossed the wire
      // DURING this specific resume.
      //
      // Build-up order is important: start with an empty URL and NO
      // publishable-key so the element connects idle. Prime the remote
      // Core with a prior error so its initial sync carries a truthy
      // `_remoteValues.error`. Only then set the URL + close the gate
      // and trigger the resume manually.
      setUrlSearch("");
      const coreWithErr = new StripeCore(provider, { webhookSecret: "whsec_test" });
      coreWithErr.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));
      // Prior failure: Core's `_setError(err)` runs, leaving
      // `coreWithErr.error.code = resume_client_secret_mismatch`. This
      // value is what the initial sync will deliver to the Shell.
      await coreWithErr.resumeIntent("pi_prior", "payment", "wrong_secret")
        .catch(() => { /* expected */ });
      expect(coreWithErr.error?.code).toBe("resume_client_secret_mismatch");

      // No publishable-key → auto-prepare bails, so the only cmd the
      // element would ever send is a later resume.
      el = createEl({ mode: "payment" });
      const { client: realClient, server } = createMockTransportPair();
      let dropCmds = false;
      const gatedClient: ClientTransport = {
        send: (msg) => {
          if (dropCmds && msg.type === "cmd") throw new Error("gated cmd send");
          realClient.send(msg);
        },
        onMessage: (handler) => realClient.onMessage(handler),
      };

      const shellProxy = new RemoteShellProxy(coreWithErr, server);
      try {
        el._connectRemote(gatedClient);
        // Initial sync delivers the pre-existing truthy error — exactly
        // the "stale remote error" precondition this test protects.
        await flushTransport(4);
        expect(el.error?.code).toBe("resume_client_secret_mismatch");

        // Now simulate the 3DS return: URL arrives, transport is gated.
        setUrlSearch("?payment_intent=pi_stale&payment_intent_client_secret=pi_stale_secret_ok");
        dropCmds = true;

        await (el as unknown as { _resumeFromRedirect: () => Promise<void> })._resumeFromRedirect();
        await flushTransport(4);

        // Core never processed this resume (cmd send was gated). The
        // authoritative proof: `_resumed` must stay false and URL
        // params preserved so a recovered transport can retry.
        expect((el as unknown as { _resumed: boolean })._resumed).toBe(false);
        const params = new URLSearchParams(globalThis.location.search);
        expect(params.has("payment_intent")).toBe(true);
        expect(params.has("payment_intent_client_secret")).toBe(true);
      } finally {
        shellProxy.dispose();
      }
    });

    it("Core-originated resume rejection still marks URL consumed (contract preserved)", async () => {
      // Counterpart to the transport-failure test: a real Core denial
      // IS a definitive answer, so URL must be stripped and a retry
      // trigger must NOT re-run resume.
      setUrlSearch("?payment_intent=pi_denied&payment_intent_client_secret=pi_denied_secret_GUESS");
      provider.retrieveResult = {
        id: "pi_denied",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_denied_secret_REAL",
      };
      el = createEl({ mode: "payment", "publishable-key": "pk_test_denial" });
      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        await flushTransport(8);
        expect(el.error?.code).toBe("resume_client_secret_mismatch");
        // URL consumed.
        const params = new URLSearchParams(globalThis.location.search);
        expect(params.has("payment_intent")).toBe(false);
        // Subsequent trigger must NOT retry — Core already spoke.
        const callsBefore = provider.retrieveCalls.length;
        await (el as unknown as { _resumeFromRedirect: () => Promise<void> })._resumeFromRedirect();
        await flushTransport(2);
        expect(provider.retrieveCalls.length).toBe(callsBefore);
      } finally {
        shellProxy.dispose();
      }
    });

    it("remote abort() cancels pi_X even when updates/return have not reached the client yet (regression: intentId sync race)", async () => {
      // Race: Core.requestIntent finishes server-side (pi_X created,
      // `_activeIntent` set, updates + return queued) but the client
      // has not processed the update frames yet. If `abort()` reads
      // `_remoteValues.intentId` at that moment, it gets null and
      // falls through to `_coreReset`, which clears `_activeIntent`
      // BEFORE prepare's supersede cleanup can call
      // `_cancelIntent(pi_X)` — and that late cancel then no-ops
      // because Core's cancelIntent bails on a null `_activeIntent`.
      // End result without the fix: pi_X orphaned at Stripe.
      //
      // Reproduce with a transport whose client-side delivery can be
      // paused. Prepare → pause → Core queues updates+return → abort
      // → resume → assert pi_X is in provider.cancelCalls.
      setUrlSearch("");
      const freshProvider = new FakeProvider();
      const freshCore = new StripeCore(freshProvider, { webhookSecret: "whsec_test" });
      freshCore.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));

      let clientHandler: ((msg: ServerMessage) => void) | null = null;
      let serverHandler: ((msg: ClientMessage) => void) | null = null;
      let clientDelivering = true;
      const clientInbox: ServerMessage[] = [];
      const client: ClientTransport = {
        send: (msg) => { if (serverHandler) Promise.resolve().then(() => serverHandler!(msg)); },
        onMessage: (h) => { clientHandler = h; },
      };
      const server: ServerTransport = {
        send: (msg) => {
          Promise.resolve().then(() => {
            if (clientDelivering) clientHandler?.(msg);
            else clientInbox.push(msg);
          });
        },
        onMessage: (h) => { serverHandler = h; },
      };
      const pauseClient = (): void => { clientDelivering = false; };
      const resumeClient = (): void => {
        clientDelivering = true;
        const pending = clientInbox.splice(0);
        for (const m of pending) clientHandler?.(m);
      };

      // Connect WITHOUT a publishable-key so auto-prepare cannot fire
      // at connect time. Let initial sync deliver to the client normally.
      el = createEl({ mode: "payment" });
      const shellProxy = new RemoteShellProxy(freshCore, server);
      try {
        el._connectRemote(client);
        await flushTransport(2);

        // Now pause the client, THEN set the publishable-key to kick
        // off auto-prepare. The requestIntent cmd flows to the server,
        // Core creates pi_shell and queues updates + return, but the
        // client cannot receive them.
        pauseClient();
        el.setAttribute("publishable-key", "pk_test_abort_race");
        // Give the server enough turns to finish the requestIntent.
        // (Our mock createPaymentIntent is synchronous, so one flush
        // would already suffice — extra flushes are a safety margin.)
        await flushTransport(4);
        expect(freshCore.intentId).toBe("pi_shell");
        expect(el.intentId).toBeNull(); // client NOT yet synced

        // User clicks abort. The fix awaits `_preparePromise`, so the
        // cancellation flows through prepare's supersede cleanup and
        // pi_shell ends up in provider.cancelCalls regardless of the
        // client-side sync timing.
        const abortPromise = el.abort();
        // Let abort park on `await preparePromise`, then resume the
        // transport so prepare can finish.
        await flushTransport(1);
        resumeClient();
        await abortPromise;
        await flushTransport(4);

        // The authoritative proof: the intent created in this aborted
        // prepare IS canceled at the provider. Without the fix, abort
        // would have raced `_coreReset` ahead of the supersede cancel
        // and left pi_shell uncanceled.
        expect(freshProvider.cancelCalls).toContain("pi_shell");
      } finally {
        shellProxy.dispose();
      }
    });

    it("remote submit reports using prepare-time intent id when update frame is delayed (regression: intentIdForReport race)", async () => {
      // Reproduce the narrow window where requestIntent returns to the
      // client, prepare() resolves, but the corresponding `intentId`
      // update frame has not been delivered yet.
      setUrlSearch("");
      const freshProvider = new FakeProvider();
      const freshCore = new StripeCore(freshProvider, { webhookSecret: "whsec_test" });
      freshCore.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));

      let clientHandler: ((msg: ServerMessage) => void) | null = null;
      let serverHandler: ((msg: ClientMessage) => void) | null = null;
      let delayUpdates = false;
      const delayedUpdates: ServerMessage[] = [];
      const client: ClientTransport = {
        send: (msg) => { if (serverHandler) Promise.resolve().then(() => serverHandler!(msg)); },
        onMessage: (h) => { clientHandler = h; },
      };
      const server: ServerTransport = {
        send: (msg) => {
          Promise.resolve().then(() => {
            if (delayUpdates && msg.type === "update") {
              delayedUpdates.push(msg);
              return;
            }
            clientHandler?.(msg);
          });
        },
        onMessage: (h) => { serverHandler = h; },
      };

      const releaseUpdates = (): void => {
        const pending = delayedUpdates.splice(0);
        for (const m of pending) clientHandler?.(m);
      };

      // No publishable-key at connect time: avoid auto-prepare and drive
      // this test with an explicit prepare/submit sequence.
      el = createEl({ mode: "payment" });
      const shellProxy = new RemoteShellProxy(freshCore, server);
      try {
        el._connectRemote(client);
        await flushTransport(2);

        el.setAttribute("publishable-key", "pk_test_submit_race");
        delayUpdates = true;
        await el.prepare();

        // requestIntent succeeded on Core, but update frames are parked.
        expect(freshCore.intentId).toBe("pi_shell");
        expect(el.intentId).toBeNull();

        await el.submit();

        // Without the fix, reportConfirmation carried intentId="" and
        // Core silently dropped the outcome. With the fix, Core reaches
        // terminal state even while client updates are delayed.
        expect(freshCore.status).toBe("succeeded");

        delayUpdates = false;
        releaseUpdates();
        await flushTransport(2);
      } finally {
        shellProxy.dispose();
      }
    });

    it("remote submit confirm throw path still reports with prepare-time intent id when update is delayed", async () => {
      setUrlSearch("");
      const freshProvider = new FakeProvider();
      const freshCore = new StripeCore(freshProvider, { webhookSecret: "whsec_test" });
      freshCore.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));

      let clientHandler: ((msg: ServerMessage) => void) | null = null;
      let serverHandler: ((msg: ClientMessage) => void) | null = null;
      let delayUpdates = false;
      const delayedUpdates: ServerMessage[] = [];
      const client: ClientTransport = {
        send: (msg) => { if (serverHandler) Promise.resolve().then(() => serverHandler!(msg)); },
        onMessage: (h) => { clientHandler = h; },
      };
      const server: ServerTransport = {
        send: (msg) => {
          Promise.resolve().then(() => {
            if (delayUpdates && msg.type === "update") {
              delayedUpdates.push(msg);
              return;
            }
            clientHandler?.(msg);
          });
        },
        onMessage: (h) => { serverHandler = h; },
      };
      const releaseUpdates = (): void => {
        const pending = delayedUpdates.splice(0);
        for (const m of pending) clientHandler?.(m);
      };

      fakes.stripeJs.confirmPayment = (async () => {
        throw new Error("confirm blew");
      }) as typeof fakes.stripeJs.confirmPayment;

      el = createEl({ mode: "payment" });
      const shellProxy = new RemoteShellProxy(freshCore, server);
      try {
        el._connectRemote(client);
        await flushTransport(2);

        el.setAttribute("publishable-key", "pk_test_submit_throw_race");
        delayUpdates = true;
        await el.prepare();
        expect(el.intentId).toBeNull();

        await expect(el.submit()).rejects.toThrow(/confirm blew/);
        expect(freshCore.status).toBe("failed");

        delayUpdates = false;
        releaseUpdates();
        await flushTransport(2);
      } finally {
        shellProxy.dispose();
      }
    });

    it("remote submit result.error path reports with prepare-time intent id when update is delayed", async () => {
      setUrlSearch("");
      const freshProvider = new FakeProvider();
      const freshCore = new StripeCore(freshProvider, { webhookSecret: "whsec_test" });
      freshCore.registerIntentBuilder(() => ({ mode: "payment", amount: 1000, currency: "usd" }));

      let clientHandler: ((msg: ServerMessage) => void) | null = null;
      let serverHandler: ((msg: ClientMessage) => void) | null = null;
      let delayUpdates = false;
      const delayedUpdates: ServerMessage[] = [];
      const client: ClientTransport = {
        send: (msg) => { if (serverHandler) Promise.resolve().then(() => serverHandler!(msg)); },
        onMessage: (h) => { clientHandler = h; },
      };
      const server: ServerTransport = {
        send: (msg) => {
          Promise.resolve().then(() => {
            if (delayUpdates && msg.type === "update") {
              delayedUpdates.push(msg);
              return;
            }
            clientHandler?.(msg);
          });
        },
        onMessage: (h) => { serverHandler = h; },
      };
      const releaseUpdates = (): void => {
        const pending = delayedUpdates.splice(0);
        for (const m of pending) clientHandler?.(m);
      };

      fakes.setConfirmResult({
        error: {
          code: "card_declined",
          message: "Declined.",
        },
      });

      el = createEl({ mode: "payment" });
      const shellProxy = new RemoteShellProxy(freshCore, server);
      try {
        el._connectRemote(client);
        await flushTransport(2);

        el.setAttribute("publishable-key", "pk_test_submit_error_race");
        delayUpdates = true;
        await el.prepare();
        expect(el.intentId).toBeNull();

        await el.submit();
        expect(freshCore.status).toBe("failed");
        expect(freshCore.error?.code).toBe("card_declined");

        delayUpdates = false;
        releaseUpdates();
        await flushTransport(2);
      } finally {
        shellProxy.dispose();
      }
    });

    it("transport disconnect dispatches null transitions for intentId/amount/paymentMethod (regression)", async () => {
      // After successful resume the element holds intentId / amount /
      // paymentMethod. A subsequent transport disconnect must notify
      // subscribers that these values have gone to null — UIs wired on
      // `*-changed` events must not keep painting stale card / total
      // data that no longer reflects any live state.
      setUrlSearch("?payment_intent=pi_disc&payment_intent_client_secret=pi_disc_secret_ok");
      provider.retrieveResult = {
        id: "pi_disc",
        status: "succeeded",
        mode: "payment",
        amount: { value: 1980, currency: "jpy" },
        paymentMethod: { id: "pm_disc", brand: "visa", last4: "4242" },
        clientSecret: "pi_disc_secret_ok",
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_disc" });
      const events: Record<string, unknown[]> = {
        intentId: [],
        amount: [],
        paymentMethod: [],
      };
      el.addEventListener("stripe-checkout:intentId-changed", (e) => events.intentId.push((e as CustomEvent).detail));
      el.addEventListener("stripe-checkout:amount-changed", (e) => events.amount.push((e as CustomEvent).detail));
      el.addEventListener("stripe-checkout:paymentMethod-changed", (e) => events.paymentMethod.push((e as CustomEvent).detail));

      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        await flushTransport(8);
        // Post-resume snapshot.
        expect(el.intentId).toBe("pi_disc");
        expect(el.amount).toEqual({ value: 1980, currency: "jpy" });
        expect(el.paymentMethod).toEqual({ id: "pm_disc", brand: "visa", last4: "4242" });
        const intentIdEventsBefore = events.intentId.length;
        const amountEventsBefore = events.amount.length;
        const pmEventsBefore = events.paymentMethod.length;

        // Simulate transport failure path — `_resetRemoteBusyState` is
        // the Shell's contract entry point for "connection is gone,
        // surface state is stale". `_initRemote`'s onFail calls it
        // before `_disposeRemote`.
        (el as unknown as { _resetRemoteBusyState: () => void })._resetRemoteBusyState();

        // Null transitions must have been dispatched for each bindable
        // that had a non-null value.
        expect(events.intentId.length).toBeGreaterThan(intentIdEventsBefore);
        expect(events.intentId[events.intentId.length - 1]).toBeNull();
        expect(events.amount.length).toBeGreaterThan(amountEventsBefore);
        expect(events.amount[events.amount.length - 1]).toBeNull();
        expect(events.paymentMethod.length).toBeGreaterThan(pmEventsBefore);
        expect(events.paymentMethod[events.paymentMethod.length - 1]).toBeNull();
      } finally {
        shellProxy.dispose();
      }
    });

    it("post-redirect resume rejects foreign intent over the wire (permission-bypass)", async () => {
      // The security contract proven for local Core must also hold when
      // the resume cmd crosses the wire: a URL with a valid-looking victim
      // intent id but a guessed client_secret must end with an error state
      // on the element, no hydrated intent.
      setUrlSearch("?payment_intent=pi_remote_victim&payment_intent_client_secret=pi_remote_victim_secret_GUESSED");
      provider.retrieveResult = {
        id: "pi_remote_victim",
        status: "succeeded",
        mode: "payment",
        amount: { value: 9999, currency: "usd" },
        paymentMethod: { id: "pm_v", brand: "visa", last4: "0000" },
        clientSecret: "pi_remote_victim_secret_REAL",
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_remote" });
      const { client, server } = createMockTransportPair();
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(client);
        await flushTransport(8);

        // Core did retrieve the intent but rejected the resume.
        expect(provider.retrieveCalls).toEqual([{ mode: "payment", id: "pi_remote_victim" }]);
        expect(core.error?.code).toBe("resume_client_secret_mismatch");
        // Element did not hydrate victim state.
        expect(el.status).not.toBe("succeeded");
        expect(el.intentId).toBeNull();
        expect(el.paymentMethod).toBeNull();
        // The denial's `code` must survive the wire. The Core dispatches
        // an `error` update before throwing, and `_setErrorStateFromUnknown`
        // must defer to that richer publish instead of overwriting with
        // the serialized throw's sparse {name,message} copy.
        expect(el.error?.code).toBe("resume_client_secret_mismatch");
      } finally {
        shellProxy.dispose();
      }
    });

    it("proxy-side failure AFTER a remote error still surfaces locally (stale-remote regression)", async () => {
      // Scenario the seq-based defer in `_setErrorStateFromUnknown`
      // protects against: (1) a remote cmd rejection leaves a truthy
      // `_remoteValues.error` (e.g. resume denial); (2) a later unrelated
      // cmd fails purely on the proxy side without reaching the Core
      // (transport send throws, invoke timeout). Without the seq check,
      // the second failure would silently defer to the first's stale
      // remote error. With the seq check, the new local error must win.
      setUrlSearch("?payment_intent=pi_stale_victim&payment_intent_client_secret=pi_stale_victim_secret_GUESSED");
      provider.retrieveResult = {
        id: "pi_stale_victim",
        status: "succeeded",
        mode: "payment",
        clientSecret: "pi_stale_victim_secret_REAL",
      };

      el = createEl({ mode: "payment", "publishable-key": "pk_test_stale" });
      const { client: realClient, server } = createMockTransportPair();

      // Gate: let the first cmd (the resume) through; drop subsequent cmds
      // by having `send` throw. This simulates "transport fine for the
      // first call, broken for the next" which is the exact shape where
      // `_remoteValues.error` would be left stale.
      let cmdSent = 0;
      const gatingClient: ClientTransport = {
        send: (msg) => {
          if (msg.type === "cmd") {
            cmdSent++;
            if (cmdSent > 1) throw new Error("synthetic cmd-2 send failure");
          }
          realClient.send(msg);
        },
        onMessage: (handler) => realClient.onMessage(handler),
      };

      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(gatingClient);
        await flushTransport(8);

        // Step 1: resume denial landed, richer code is visible.
        expect(el.error?.code).toBe("resume_client_secret_mismatch");

        // Step 2: trigger a second cmd that the gated transport will
        // refuse to send. `prepare()` routes through the proxy which
        // invokes `requestIntent` — a cmd.
        await expect(el.prepare()).rejects.toBeDefined();
        await flushTransport(2);

        // The stale remote error must NOT mask the new transport failure.
        // With the coarse `if (remote) return` guard, this would still
        // read as `resume_client_secret_mismatch`; with the seq guard,
        // the proxy-side error surfaces through local state.
        expect(el.error?.message).toMatch(/synthetic cmd-2 send failure/);
        expect(el.error?.code).not.toBe("resume_client_secret_mismatch");
      } finally {
        shellProxy.dispose();
      }
    });

    it("pure proxy-side rejection (no remote error update) still surfaces as local error", async () => {
      // Regression guard for the `_setErrorStateFromUnknown` remote-defer
      // branch: it must NOT swallow rejections for which the Core never
      // dispatched an error update (proxy timeout, validation failure on a
      // property that isn't in the bindable surface). A transport that
      // refuses every invoke by throwing from `send` is the most direct
      // way to model this — the Core never sees the cmd, so nothing lands
      // in `_remoteValues.error`, and the local fallback must fire.
      el = createEl({ mode: "payment", "publishable-key": "pk_test_remote" });
      const { client: realClient, server } = createMockTransportPair();
      const failingClient: ClientTransport = {
        send: (msg) => {
          // Drop all cmd frames so pending invokes never resolve; let
          // sync/set pass so initial hookup still works.
          if (msg.type === "cmd") {
            throw new Error("synthetic transport send failure");
          }
          realClient.send(msg);
        },
        onMessage: (handler) => realClient.onMessage(handler),
      };
      const shellProxy = new RemoteShellProxy(core, server);
      try {
        el._connectRemote(failingClient);
        await flushTransport();
        el.setAttribute("publishable-key", "pk_B"); // triggers prepare → requestIntent cmd
        await flushTransport(4);
        // Core's `_remoteValues.error` was never populated — the Core
        // never received the cmd — so local state must surface.
        expect(el.error).not.toBeNull();
        expect(el.error?.message).toMatch(/synthetic transport send failure/);
      } finally {
        shellProxy.dispose();
      }
    });

    it("local unknown-object fallback preserves declineCode/type fields", () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_local" });
      el.attachLocalCore(core);

      (el as any)._setErrorStateFromUnknown({
        code: "card_declined",
        declineCode: "insufficient_funds",
        type: "card_error",
        message: "Declined.",
      });
      expect(el.error?.code).toBe("card_declined");
      expect(el.error?.declineCode).toBe("insufficient_funds");
      expect(el.error?.type).toBe("card_error");
      expect(el.error?.message).toBe("Declined.");
    });

    it("local unknown-object fallback falls back to snake_case decline_code", () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_local" });
      el.attachLocalCore(core);

      (el as any)._setErrorStateFromUnknown({
        code: "card_declined",
        decline_code: "insufficient_funds",
        message: "Declined.",
      });
      expect(el.error?.code).toBe("card_declined");
      expect(el.error?.declineCode).toBe("insufficient_funds");
      expect(el.error?.type).toBeUndefined();
      expect(el.error?.message).toBe("Declined.");
    });

    it("local unknown-object fallback keeps optional fields undefined when missing", () => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_local" });
      el.attachLocalCore(core);

      (el as any)._setErrorStateFromUnknown({ message: "x" });
      expect(el.error?.code).toBeUndefined();
      expect(el.error?.declineCode).toBeUndefined();
      expect(el.error?.type).toBeUndefined();
      expect(el.error?.message).toBe("x");
    });
  });

  describe("lifecycle commands", () => {
    beforeEach(() => {
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
    });

    it("abort() cancels the intent and returns to idle", async () => {
      await el.prepare();
      await el.abort();
      expect(provider.cancelCalls).toContain("pi_shell");
      expect(el.intentId).toBeNull();
      expect(el.status).toBe("idle");
    });

    it("reset() returns to idle without calling the provider", async () => {
      await el.prepare();
      el.reset();
      expect(el.status).toBe("idle");
      expect(provider.cancelCalls).toHaveLength(0);
    });

    it("declarative inputs forward to the Core", async () => {
      // Re-set after attach to drive attributeChangedCallback sync.
      el.setAttribute("amount-value", "500");
      el.setAttribute("amount-currency", "usd");
      el.setAttribute("customer-id", "cus_1");
      expect(core.amountValue).toBe(500);
      expect(core.amountCurrency).toBe("usd");
      expect(core.customerId).toBe("cus_1");
    });

    it("amount-value attribute that does not parse to a finite number dispatches stripe-checkout:input-warning", () => {
      // Pin SPEC §7.4 contract: an unparseable `amount-value` (e.g. "abc")
      // collapses the getter / Core-synced value to `null` BUT leaves the
      // raw string on the DOM attribute. Without an explicit warning,
      // subscribers wired to the attribute would see "abc" while the Core
      // observed `null` — silent divergence. The warning carries `field`,
      // `value` (the raw attribute string), and `message`.
      const warnings: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:input-warning", (e) => warnings.push(e as CustomEvent));

      el.setAttribute("amount-value", "abc");

      expect(warnings).toHaveLength(1);
      const detail = warnings[0].detail as { field: string; value: string; message: string };
      expect(detail.field).toBe("amountValue");
      expect(detail.value).toBe("abc");
      expect(typeof detail.message).toBe("string");
      // Core / getter collapsed to null; raw attribute is preserved.
      expect(core.amountValue).toBeNull();
      expect(el.getAttribute("amount-value")).toBe("abc");
    });

    it("amount-value attribute with a finite number does NOT dispatch stripe-checkout:input-warning", () => {
      // Negative path: a parseable value must NOT fire the warning, or the
      // event becomes noise that subscribers learn to ignore.
      const warnings: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:input-warning", (e) => warnings.push(e as CustomEvent));

      el.setAttribute("amount-value", "1000");

      expect(warnings).toHaveLength(0);
      expect(core.amountValue).toBe(1000);
    });

    it("amount-value attribute with a negative number dispatches stripe-checkout:input-warning and does NOT throw out of attributeChangedCallback", () => {
      // Regression: the attribute path used to forward negative values to
      // the Core's setter, which raises synchronously via `raiseError`.
      // That throw escapes `attributeChangedCallback` and corrupts the
      // browser's microtask queue in local mode (remote mode silently
      // swallowed it via `setWithAck`'s promise catch — asymmetric).
      // Mirror the unparseable-value contract: emit a warning, collapse
      // the synced Core value to null, leave the raw DOM attribute as-is.
      const warnings: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:input-warning", (e) => warnings.push(e as CustomEvent));

      // Must NOT throw — the previous code did when the negative value
      // hit `core.amountValue = -100`.
      expect(() => el.setAttribute("amount-value", "-100")).not.toThrow();

      expect(warnings).toHaveLength(1);
      const detail = warnings[0].detail as { field: string; value: string };
      expect(detail.field).toBe("amountValue");
      expect(detail.value).toBe("-100");
      expect(core.amountValue).toBeNull();
      // Raw attribute is preserved (matches the unparseable-value contract).
      expect(el.getAttribute("amount-value")).toBe("-100");
    });

    it('mode attribute that is not "payment" or "setup" dispatches stripe-checkout:input-warning', () => {
      // Pin the symmetric contract for `mode`: the getter collapses every
      // unrecognized value to "payment", so a typo (`mode="setpu"`) would
      // silently route an app intending "setup" through the payment path.
      // The warning carries the raw attribute value so subscribers can
      // distinguish "unset" from "typo'd unset" without re-reading the DOM.
      const warnings: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:input-warning", (e) => warnings.push(e as CustomEvent));

      el.setAttribute("mode", "setpu");

      expect(warnings).toHaveLength(1);
      const detail = warnings[0].detail as { field: string; value: string; message: string };
      expect(detail.field).toBe("mode");
      expect(detail.value).toBe("setpu");
      expect(typeof detail.message).toBe("string");
      // Raw attribute is preserved; Core / getter collapsed to the default.
      expect(el.getAttribute("mode")).toBe("setpu");
      expect(core.mode).toBe("payment");
    });

    it('mode attribute that is "payment" or "setup" does NOT dispatch stripe-checkout:input-warning', () => {
      // Negative path: parseable values must NOT fire the warning, or the
      // event becomes noise that subscribers learn to ignore. Cover both
      // legal tokens in one test — they share the same code path.
      const warnings: CustomEvent[] = [];
      el.addEventListener("stripe-checkout:input-warning", (e) => warnings.push(e as CustomEvent));

      el.setAttribute("mode", "setup");
      el.setAttribute("mode", "payment");

      expect(warnings).toHaveLength(0);
    });

    it("trigger=true fires submit()", async () => {
      const submitSpy = vi.spyOn(el, "submit");
      el.trigger = true;
      await new Promise(r => setTimeout(r, 0));
      expect(submitSpy).toHaveBeenCalled();
    });

    it("rapid false→true→false→true does NOT lose the trailing true state (regression: trigger race)", async () => {
      // Regression: the trigger setter's `.finally()` chain attached a
      // new handler on every false→true write, so two rapid cycles
      // against the same in-flight `submit()` produced TWO `.finally`
      // handlers. When submit resolved, the FIRST `.finally` saw
      // `_trigger = true` and flipped it to `false` (dispatching a
      // spurious `trigger-changed: false`), and the second `.finally`
      // saw the now-`false` and did nothing — even though the user's
      // last write was `true`. The fix introduces `_triggerGeneration`
      // so only the most-recent setter's `.finally` is authoritative.
      //
      // Park `submit()` in a manual-release promise so we can drive
      // the trigger toggles entirely within the in-flight window.
      let releaseSubmit!: () => void;
      const submitPromise = new Promise<void>(r => { releaseSubmit = r; });
      vi.spyOn(el, "submit").mockImplementation(() => submitPromise);

      const events: boolean[] = [];
      el.addEventListener("stripe-checkout:trigger-changed", (e) => {
        events.push((e as CustomEvent).detail as boolean);
      });

      el.trigger = true;   // cycle 1 start, fires submit. events: [true]
      el.trigger = false;  // edge to false. events: [true, false]
      el.trigger = true;   // cycle 2 start. NOT a new submit (dedup
                           // via `_submitPromise`), but a new
                           // `.finally` chain attaches. events:
                           // [true, false, true]

      // Now release the in-flight submit. Both `.finally` chains run.
      // Without the generation guard, the first one flips `_trigger`
      // back to false and dispatches a spurious `false`. With the
      // guard, only the most-recent (`triggerGen === current`) chain
      // sets `_trigger = false`.
      releaseSubmit();
      await new Promise(r => setTimeout(r, 0));
      await new Promise(r => setTimeout(r, 0));

      // After both `.finally`s run, the most-recent cycle's finally
      // flipped `_trigger` to false — the user's last manual write was
      // `true`, but the natural finally-after-submit-resolved is the
      // authoritative source. Critical assertion: there is exactly ONE
      // trailing `false` event, not the spurious double-false from the
      // race (without the generation guard, the first `.finally` would
      // also have dispatched a `false`, then the second `.finally`'s
      // `if (this._trigger)` check would see it was already false and
      // suppress — but the spurious first false has already been
      // observed by listeners). After this fix, the first `.finally`
      // is a no-op due to generation mismatch and only the latest
      // cycle's `.finally` writes back.
      const trailingFalses = events.filter((_, i) => i >= 3);
      expect(trailingFalses).toEqual([false]);
      // The first three are the user-driven sequence.
      expect(events.slice(0, 3)).toEqual([true, false, true]);
    });
  });

  describe("appearance hot-swap", () => {
    // The setter keeps best-effort behavior to survive providers whose
    // Elements group predates `update`, but now emits an observability
    // warning event when `update` exists and throws.
    it("forwards a post-mount appearance change to elements.update()", async () => {
      const updateCalls: Record<string, unknown>[] = [];
      const paymentElement: StripePaymentElementLike = {
        mount() {}, unmount() {}, destroy() {}, on() {},
      };
      const elements = {
        create() { return paymentElement; },
        getElement() { return paymentElement; },
        update(opts: Record<string, unknown>) { updateCalls.push(opts); },
      } as StripeElementsLike;
      const stripeJs: StripeJsLike = {
        elements: () => elements,
        async confirmPayment() { return { paymentIntent: { id: "pi_shell", status: "succeeded" } }; },
        async confirmSetup() { return { setupIntent: { id: "seti_shell", status: "succeeded" } }; },
      };
      WcsStripe.setLoader(async () => stripeJs);

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();

      const nextAppearance = { theme: "night", variables: { colorPrimary: "#09f" } };
      el.appearance = nextAppearance;

      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]).toEqual({ appearance: nextAppearance });
    });

    it("tolerates an Elements group that does not implement update()", async () => {
      // Older/custom Stripe.js surfaces may not expose `update`. Setting
      // appearance after mount must not throw — the new value is simply
      // picked up on the next mount. Guards the silent try/catch in the
      // setter from becoming a hard failure.
      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.attachLocalCore(core);
      await el.prepare();
      expect(() => {
        el.appearance = { theme: "stripe" };
      }).not.toThrow();
      expect(el.appearance).toEqual({ theme: "stripe" });
    });

    it("dispatches stripe-checkout:appearance-warning when elements.update throws", async () => {
      const warnings: CustomEvent[] = [];
      const paymentElement: StripePaymentElementLike = {
        mount() {}, unmount() {}, destroy() {}, on() {},
      };
      const elements = {
        create() { return paymentElement; },
        getElement() { return paymentElement; },
        update() { throw new Error("unsupported appearance"); },
      } as StripeElementsLike;
      const stripeJs: StripeJsLike = {
        elements: () => elements,
        async confirmPayment() { return { paymentIntent: { id: "pi_shell", status: "succeeded" } }; },
        async confirmSetup() { return { setupIntent: { id: "seti_shell", status: "succeeded" } }; },
      };
      WcsStripe.setLoader(async () => stripeJs);

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.addEventListener("stripe-checkout:appearance-warning", (e) => warnings.push(e as CustomEvent));
      el.attachLocalCore(core);
      await el.prepare();

      expect(() => {
        el.appearance = { theme: "night" };
      }).not.toThrow();
      expect(warnings).toHaveLength(1);
      expect((warnings[0].detail as any).message).toContain("Failed to apply appearance");
      expect((warnings[0].detail as any).error).toBeInstanceOf(Error);
    });

    it("_mountElements retries with appearance: undefined when stripe.elements() throws (regression: prepare wedge on bad appearance)", async () => {
      // Regression: setter-side validation cannot catch every shape
      // Stripe.js will reject at `elements()` time, and a malformed
      // appearance assigned BEFORE prepare wedged the entire prepare
      // flow with no recovery path. The mount-time retry isolates the
      // appearance contribution: if the second `elements(...)` call
      // (with `appearance: undefined`) succeeds, prepare completes
      // with default styling.
      const warnings: CustomEvent[] = [];
      const paymentElement: StripePaymentElementLike = {
        mount() {}, unmount() {}, destroy() {}, on() {},
      };
      const elements = {
        create() { return paymentElement; },
        getElement() { return paymentElement; },
      } as StripeElementsLike;
      let callCount = 0;
      const stripeJs: StripeJsLike = {
        elements: (opts: { clientSecret: string; appearance?: Record<string, unknown> }) => {
          callCount++;
          // First call (appearance present) throws; retry path with
          // `appearance: undefined` succeeds.
          if (callCount === 1 && opts.appearance !== undefined) {
            throw new Error("malformed appearance");
          }
          return elements;
        },
        async confirmPayment() { return { paymentIntent: { id: "pi_shell", status: "succeeded" } }; },
        async confirmSetup() { return { setupIntent: { id: "seti_shell", status: "succeeded" } }; },
      };
      WcsStripe.setLoader(async () => stripeJs);

      el = createEl({ mode: "payment", "publishable-key": "pk_test_123" });
      el.addEventListener("stripe-checkout:appearance-warning", (e) => warnings.push(e as CustomEvent));
      el.attachLocalCore(core);
      // Pre-prepare: assign appearance directly to the field (the
      // public setter has its own try/catch around update(), which
      // doesn't fire here since Elements isn't mounted yet).
      el.appearance = { variables: { colorPrimary: "#bad" } };

      // prepare() MUST succeed — the retry recovers.
      await expect(el.prepare()).resolves.toBeUndefined();
      expect(callCount).toBe(2); // initial throw + retry without appearance
      // The retry path emits a warning so apps can see why default
      // styling was used.
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      const mountWarning = warnings.find(w =>
        ((w.detail as any).message as string).includes("retrying with default appearance"));
      expect(mountWarning).toBeDefined();
    });
  });

  describe("setLoader / resetLoader", () => {
    // resetLoader is the dispose-counterpart to setLoader — restores the
    // default Stripe.js loader so a test-mounted mock does not leak into
    // subsequent tests that forgot to overwrite it.
    it("resetLoader swaps the active loader back to the default (mock spy stops firing)", async () => {
      let mockLoaderCalls = 0;
      WcsStripe.setLoader(async () => {
        mockLoaderCalls++;
        return fakes.stripeJs;
      });

      el = createEl({ mode: "payment", "publishable-key": "pk_test_reset" });
      el.attachLocalCore(core);
      await el.prepare();
      expect(mockLoaderCalls).toBe(1);

      WcsStripe.resetLoader();
      // After reset, the mock spy is no longer reachable — the private
      // `_loader` slot now holds the default reference. We verify this by
      // checking the private slot directly (the default path would try
      // to `import("@stripe/stripe-js")`, which is not installed in this
      // test env, so exercising it end-to-end would produce an unrelated
      // reject). Slot identity comparison is the narrow assertion the
      // dispose API actually promises.
      const defaultLoader = (WcsStripe as unknown as { _DEFAULT_LOADER: unknown })._DEFAULT_LOADER;
      const activeLoader = (WcsStripe as unknown as { _loader: unknown })._loader;
      expect(activeLoader).toBe(defaultLoader);

      // Reinstate the fake loader for the rest of the describe block.
      WcsStripe.setLoader(async () => fakes.stripeJs);
    });

    it("resetLoader is idempotent", () => {
      expect(() => {
        WcsStripe.resetLoader();
        WcsStripe.resetLoader();
      }).not.toThrow();
      // Reinstate the fake loader for other tests.
      WcsStripe.setLoader(async () => fakes.stripeJs);
    });
  });

  describe("setLogger / resetLogger", () => {
    // The static logger is a global no-op-by-default sink that
    // `_disposeRemoteWithBestEffortReset` fans `reportFailure(...)` out to
    // alongside the `stripe-checkout:dispose-warning` event. Because that
    // cleanup runs AFTER the element is DOM-detached, regular bubbling
    // listeners at `document` / global level can no longer see those
    // events — the static logger is what production observability hooks
    // for those failure phases.

    afterEach(() => {
      // Avoid cross-test leakage of the installed sink.
      WcsStripe.resetLogger();
    });

    it("setLogger validates input — non-function values are coerced to no-op (typeof guard)", () => {
      // The setter's `typeof logger === "function"` guard exists so a
      // caller passing `null` / `undefined` / a string does not break the
      // dispose path with a `TypeError: Stripe._logger is not a function`.
      WcsStripe.setLogger(null as unknown as (phase: string, error: unknown) => void);
      const active = (WcsStripe as unknown as { _logger: unknown })._logger;
      expect(typeof active).toBe("function");
      // The coerced no-op must not throw when called.
      expect(() => (active as (p: string, e: unknown) => void)("phase", new Error("x"))).not.toThrow();
    });

    it("resetLogger restores the default no-op sink", () => {
      const sink: { phase: string; error: unknown }[] = [];
      WcsStripe.setLogger((phase, error) => sink.push({ phase, error }));
      WcsStripe.resetLogger();
      // After reset, calling the active logger must be a no-op — the
      // sink we installed is no longer reachable.
      const active = (WcsStripe as unknown as { _logger: (p: string, e: unknown) => void })._logger;
      active("phase", new Error("x"));
      expect(sink).toHaveLength(0);
    });

    it("_disposeRemoteWithBestEffortReset routes reportFailure through the installed logger", async () => {
      // The dispose-cleanup phase logger sees every cleanup phase whose
      // callback throws (cancelIntent / reset / unbind / proxy.dispose /
      // ws.close). This pins that wiring — the production observability
      // surface that this whole feature exists for.
      const calls: { phase: string; error: unknown }[] = [];
      WcsStripe.setLogger((phase, error) => calls.push({ phase, error }));

      el = createEl({ mode: "payment" });
      // Build a proxy whose `reset` rejects so the dispose path's
      // `reportFailure("reset", e)` fires.
      const proxy = {
        invoke: async (name: string) => {
          if (name === "reset") throw new Error("synthetic reset failure");
        },
        invokeWithOptions: async () => {},
        dispose: () => {},
      };
      (el as unknown as { _proxy: unknown })._proxy = proxy;
      (el as unknown as { _unbind: (() => void) | null })._unbind = () => {};
      (el as unknown as { _ws: { close: () => void } | null })._ws = { close: () => {} };

      el.remove();
      await flushTransport(4);

      // The logger received the reset-phase failure. Bubbling
      // `stripe-checkout:dispose-warning` events alone would not reach a
      // global / document-level subscriber on the now-detached element —
      // the logger is the only path that can.
      const resetCalls = calls.filter(c => c.phase === "reset");
      expect(resetCalls).toHaveLength(1);
      expect((resetCalls[0].error as Error).message).toBe("synthetic reset failure");
    });

    it("a misbehaving logger does not break the dispose-cleanup path", async () => {
      // The `try { Stripe._logger(phase, error); } catch { /* ... */ }`
      // guard exists so a logger throw cannot half-tear-down the element.
      // Verify by installing a logger that always throws, then asserting
      // the rest of the cleanup (proxy.dispose / ws.close) still runs.
      WcsStripe.setLogger(() => { throw new Error("logger crashed"); });

      el = createEl({ mode: "payment" });
      const order: string[] = [];
      const proxy = {
        invoke: async (name: string) => {
          if (name === "reset") throw new Error("synthetic reset failure");
        },
        invokeWithOptions: async () => {},
        dispose: () => { order.push("dispose"); },
      };
      (el as unknown as { _proxy: unknown })._proxy = proxy;
      (el as unknown as { _unbind: (() => void) | null })._unbind = () => { order.push("unbind"); };
      (el as unknown as { _ws: { close: () => void } | null })._ws = { close: () => { order.push("ws.close"); } };

      el.remove();
      await flushTransport(4);

      // Despite the logger throwing on the reset-phase failure, the
      // remaining cleanup must still run.
      expect(order).toContain("unbind");
      expect(order).toContain("dispose");
      expect(order).toContain("ws.close");
    });
  });

  describe("connectedCallback remote bootstrap failure paths", () => {
    // These tests exercise the `_initRemote` error paths reached through
    // connectedCallback's try/catch: empty remote URL under env mode, and
    // `new WebSocket(url)` throwing on an unparseable URL. Both paths must
    // end with a visible error state and no live `_proxy` / `_ws` — a
    // silent no-op would leave the element looking "ready but idle" even
    // though remote is fundamentally unavailable.

    // Shared state for restoring module-global config between tests.
    let configSnapshot: {
      enableRemote: boolean;
      remoteSettingType: "env" | "config";
      remoteCoreUrl: string;
    };
    const g = globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
      STRIPE_REMOTE_CORE_URL?: string;
    };
    let savedEnv: string | undefined;
    let hadGlobalUrl = false;
    let savedGlobalUrl: string | undefined;

    beforeEach(() => {
      configSnapshot = {
        enableRemote: stripeConfig.remote.enableRemote,
        remoteSettingType: stripeConfig.remote.remoteSettingType,
        remoteCoreUrl: stripeConfig.remote.remoteCoreUrl,
      };
      savedEnv = g.process?.env?.STRIPE_REMOTE_CORE_URL;
      hadGlobalUrl = "STRIPE_REMOTE_CORE_URL" in g;
      savedGlobalUrl = g.STRIPE_REMOTE_CORE_URL;
    });

    afterEach(() => {
      setConfig({
        remote: {
          enableRemote: configSnapshot.enableRemote,
          remoteSettingType: configSnapshot.remoteSettingType,
          remoteCoreUrl: configSnapshot.remoteCoreUrl,
        },
      });
      if (g.process?.env) {
        if (savedEnv === undefined) delete g.process.env.STRIPE_REMOTE_CORE_URL;
        else g.process.env.STRIPE_REMOTE_CORE_URL = savedEnv;
      }
      if (hadGlobalUrl) g.STRIPE_REMOTE_CORE_URL = savedGlobalUrl;
      else delete g.STRIPE_REMOTE_CORE_URL;
    });

    it("enableRemote=true with env mode + empty URL surfaces a local error and does NOT create a WebSocket", () => {
      // Env mode: the URL is resolved at runtime from process.env /
      // globalThis. Neither source set → `getRemoteCoreUrl()` returns "".
      // `_initRemote` must raise before `new WebSocket("")`, and
      // connectedCallback's try/catch must route the throw into local
      // error state rather than letting it escape.
      setConfig({
        remote: {
          enableRemote: true,
          remoteSettingType: "env",
          // remoteCoreUrl is ignored in env mode, but we need a value
          // to pass setConfig's "enableRemote without URL" cross-check.
          remoteCoreUrl: "wss://ignored-by-env-mode/",
        },
      });
      if (g.process?.env) delete g.process.env.STRIPE_REMOTE_CORE_URL;
      delete g.STRIPE_REMOTE_CORE_URL;

      const originalWS = globalThis.WebSocket;
      let wsCtorCalls = 0;
      try {
        globalThis.WebSocket = class extends originalWS {
          constructor(url: string) {
            wsCtorCalls++;
            super(url);
          }
        } as unknown as typeof WebSocket;

        el = createEl({ mode: "payment", "publishable-key": "pk_test_remote" });
        // connectedCallback fired at appendChild; the throw from
        // _initRemote must have been caught and stashed onto the
        // element's local error state.
        expect(el.error?.message).toMatch(/remoteCoreUrl/);
        expect((el as unknown as { _isRemote: boolean })._isRemote).toBe(false);
        expect((el as unknown as { _ws: unknown })._ws).toBeNull();
        expect(wsCtorCalls).toBe(0);
      } finally {
        globalThis.WebSocket = originalWS;
      }
    });

    it("WebSocket constructor throwing on URL parse surfaces a local error", () => {
      // `new WebSocket("not://a valid url")` throws synchronously in
      // browsers (SyntaxError: invalid URL). We simulate that here to
      // avoid relying on happy-dom's exact URL-validation behavior.
      setConfig({
        remote: {
          enableRemote: true,
          remoteSettingType: "config",
          remoteCoreUrl: "ws://broken-but-stored/",
        },
      });

      const originalWS = globalThis.WebSocket;
      try {
        globalThis.WebSocket = class {
          constructor() {
            // Mirror the DOMException shape real browsers emit on a
            // malformed WebSocket URL so the catch path sees a realistic
            // message for its diagnostic.
            throw new Error("SyntaxError: Invalid URL");
          }
        } as unknown as typeof WebSocket;

        el = createEl({ mode: "payment", "publishable-key": "pk_test_remote" });
        // The throw from `new WebSocket(...)` inside _initRemote must
        // have been caught by connectedCallback and routed to local error.
        // Element must NOT hold a half-initialized _ws/_proxy pair.
        expect(el.error?.message).toMatch(/Invalid URL/);
        expect((el as unknown as { _isRemote: boolean })._isRemote).toBe(false);
        expect((el as unknown as { _ws: unknown })._ws).toBeNull();
      } finally {
        globalThis.WebSocket = originalWS;
      }
    });
  });
});
