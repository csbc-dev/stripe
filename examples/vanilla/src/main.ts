// stripe-setup is imported first so it registers <stripe-checkout> + enables
// remote mode before we touch the element below.
import { PUBLISHABLE_KEY, IS_MOCK } from "./stripe-setup";
import { bind } from "@wc-bindable/core";
import type {
  StripeStatus,
  StripeAmount,
  StripePaymentMethod,
  StripeError,
} from "@csbc-dev/stripe";
import "./style.css";

type StripeCheckoutEl = HTMLElement & {
  submit(): Promise<void>;
  reset(): void;
  abort(): Promise<void>;
};

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`missing element: ${sel}`);
  return node;
}

const el = $<StripeCheckoutEl>("#checkout");
const statusEl = $("#status");
const loadingEl = $("#loading");
const amountEl = $("#amount");
const pmEl = $("#pm");
const intentIdEl = $("#intentId");
const errorEl = $("#error");
const payBtn = $<HTMLButtonElement>("#pay");
const resetBtn = $<HTMLButtonElement>("#reset");

$("#mode-tag").textContent = IS_MOCK ? "mock" : "live test";

let status: StripeStatus = "idle";
let loading = false;

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

function refreshPayButton(): void {
  payBtn.disabled = !(status === "collecting" && !loading);
}

// bind() reads each output property's current value synchronously, then
// subscribes to its `stripe-checkout:*-changed` CustomEvent. This ~20-line
// primitive is exactly what @wc-bindable/react and /vue wrap.
const unbind = bind(el, (name, value) => {
  switch (name) {
    case "status":
      status = value as StripeStatus;
      statusEl.textContent = status;
      statusEl.className = `badge ${status}`;
      refreshPayButton();
      break;
    case "loading":
      loading = value as boolean;
      loadingEl.textContent = String(loading);
      refreshPayButton();
      break;
    case "amount":
      amountEl.textContent = formatAmount(value as StripeAmount | null);
      break;
    case "paymentMethod": {
      const pm = value as StripePaymentMethod | null;
      pmEl.textContent = pm ? `${pm.brand} •• ${pm.last4}` : "—";
      break;
    }
    case "intentId":
      intentIdEl.textContent = (value as string | null) ?? "—";
      break;
    case "error": {
      const err = value as StripeError | null;
      if (err) {
        errorEl.hidden = false;
        errorEl.textContent = `⚠ ${err.message}${err.code ? ` (${err.code})` : ""}`;
      } else {
        errorEl.hidden = true;
        errorEl.textContent = "";
      }
      break;
    }
  }
});

// publishable-key and return-url are not wcBindable inputs — set them as
// attributes. Setting publishable-key LAST satisfies the final auto-prepare
// prerequisite, so Elements mounts on its own.
el.setAttribute("return-url", location.origin + location.pathname);
el.setAttribute("publishable-key", PUBLISHABLE_KEY);

payBtn.addEventListener("click", () => {
  void el.submit();
});
resetBtn.addEventListener("click", () => el.reset());

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    payBtn.textContent = radio.value === "setup" ? "Save card" : "Pay";
    el.reset(); // clean slate before switching mode; the element re-prepares.
    el.setAttribute("mode", radio.value);
  });
});

window.addEventListener("beforeunload", () => unbind());
