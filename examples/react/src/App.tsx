import { useCallback, useRef, useState } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type { WcsStripeValues, StripeAmount } from "@csbc-dev/stripe";
import { PUBLISHABLE_KEY, IS_MOCK } from "./stripe-setup";

type StripeCheckoutEl = HTMLElement & {
  submit(): Promise<void>;
  reset(): void;
  abort(): Promise<void>;
};

const RETURN_URL = location.origin + location.pathname;

function formatAmount(a: StripeAmount | null): string {
  if (!a) return "—";
  const zeroDecimal = a.currency.toLowerCase() === "jpy";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: a.currency }).format(
      zeroDecimal ? a.value : a.value / 100,
    );
  } catch {
    return `${a.value} ${a.currency}`;
  }
}

export function App() {
  const [mode, setMode] = useState<"payment" | "setup">("payment");

  // useWcBindable syncs every wcBindable OUTPUT property of <stripe-checkout>
  // (status/loading/amount/paymentMethod/intentId/error/trigger) into `values`
  // — no manual addEventListener.
  const [bindRef, values] = useWcBindable<StripeCheckoutEl, WcsStripeValues>({
    status: "idle",
    loading: false,
    amount: null,
    paymentMethod: null,
    intentId: null,
    error: null,
    trigger: false,
  });

  // The bind ref only stores the node internally; keep our own handle so we
  // can call the imperative commands (submit / reset / abort).
  const elRef = useRef<StripeCheckoutEl | null>(null);
  const setRef = useCallback(
    (node: StripeCheckoutEl | null) => {
      elRef.current = node;
      bindRef(node);
    },
    [bindRef],
  );

  const pay = useCallback(() => {
    void elRef.current?.submit();
  }, []);
  const reset = useCallback(() => elRef.current?.reset(), []);

  const switchMode = useCallback((next: "payment" | "setup") => {
    // Switching mode needs a clean slate (reset tears down Elements + the
    // active intent); the element then auto-prepares the new mode.
    elRef.current?.reset();
    setMode(next);
  }, []);

  const canPay = values.status === "collecting" && !values.loading;

  return (
    <main>
      <header>
        <h1>@csbc-dev/stripe × React</h1>
        <p>
          <code>&lt;stripe-checkout&gt;</code> bound with <code>@wc-bindable/react</code> ·{" "}
          <span className="mode-tag">{IS_MOCK ? "mock" : "live test"}</span> mode
        </p>
      </header>

      <div className="row">
        <label>
          <input type="radio" name="mode" checked={mode === "payment"} onChange={() => switchMode("payment")} /> payment
        </label>
        <label>
          <input type="radio" name="mode" checked={mode === "setup"} onChange={() => switchMode("setup")} /> setup
        </label>
      </div>

      {/* Inputs are plain attributes. amount-value is only a HINT — the server
          decides the real total. */}
      <stripe-checkout
        ref={setRef}
        mode={mode}
        publishable-key={PUBLISHABLE_KEY}
        amount-value="1980"
        amount-currency="jpy"
        return-url={RETURN_URL}
      />

      <dl className="state">
        <div>
          <dt>status</dt>
          <dd>
            <span className={`badge ${values.status}`}>{values.status}</span>
          </dd>
        </div>
        <div>
          <dt>loading</dt>
          <dd>{String(values.loading)}</dd>
        </div>
        <div>
          <dt>amount (server total)</dt>
          <dd>{formatAmount(values.amount)}</dd>
        </div>
        <div>
          <dt>paymentMethod</dt>
          <dd>
            {values.paymentMethod
              ? `${values.paymentMethod.brand} •• ${values.paymentMethod.last4}`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>intentId</dt>
          <dd>
            <code>{values.intentId ?? "—"}</code>
          </dd>
        </div>
      </dl>

      {values.error && (
        <p className="error">
          ⚠ {values.error.message}
          {values.error.code ? ` (${values.error.code})` : ""}
        </p>
      )}

      <div className="row">
        <button onClick={pay} disabled={!canPay}>
          {mode === "setup" ? "Save card" : "Pay"}
        </button>
        <button className="ghost" onClick={reset}>
          Reset
        </button>
      </div>

      <p className="hint">
        The <strong>amount</strong> shown comes from the server's IntentBuilder, not the{" "}
        <code>amount-value</code> attribute — the Core owns the decision.
      </p>
    </main>
  );
}
