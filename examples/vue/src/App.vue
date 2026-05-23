<script setup lang="ts">
import { computed, ref } from "vue";
import { useWcBindable } from "@wc-bindable/vue";
import type { WcsStripeValues, StripeAmount } from "@csbc-dev/stripe";
import { PUBLISHABLE_KEY, IS_MOCK } from "./stripe-setup";

type StripeCheckoutEl = HTMLElement & {
  submit(): Promise<void>;
  reset(): void;
  abort(): Promise<void>;
};

const RETURN_URL = location.origin + location.pathname;
const mode = ref<"payment" | "setup">("payment");

// useWcBindable syncs every wcBindable OUTPUT property of <stripe-checkout>
// into the reactive `values` object — no manual addEventListener. `el` is a
// Vue template ref to the element (used for the imperative commands).
const { ref: el, values } = useWcBindable<StripeCheckoutEl, WcsStripeValues>({
  status: "idle",
  loading: false,
  amount: null,
  paymentMethod: null,
  intentId: null,
  error: null,
  trigger: false,
});

const canPay = computed(() => values.status === "collecting" && !values.loading);

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

function pay() {
  void el.value?.submit();
}
function reset() {
  el.value?.reset();
}
function switchMode(next: "payment" | "setup") {
  // Switching mode needs a clean slate; the element then auto-prepares the new mode.
  el.value?.reset();
  mode.value = next;
}
</script>

<template>
  <main>
    <header>
      <h1>@csbc-dev/stripe × Vue</h1>
      <p>
        <code>&lt;stripe-checkout&gt;</code> bound with <code>@wc-bindable/vue</code> ·
        <span class="mode-tag">{{ IS_MOCK ? "mock" : "live test" }}</span> mode
      </p>
    </header>

    <div class="row">
      <label><input type="radio" name="mode" :checked="mode === 'payment'" @change="switchMode('payment')" /> payment</label>
      <label><input type="radio" name="mode" :checked="mode === 'setup'" @change="switchMode('setup')" /> setup</label>
    </div>

    <!-- Inputs are plain attributes. amount-value is only a HINT — the server decides the total. -->
    <stripe-checkout
      ref="el"
      :mode="mode"
      :publishable-key="PUBLISHABLE_KEY"
      amount-value="1980"
      amount-currency="jpy"
      :return-url="RETURN_URL"
    />

    <dl class="state">
      <div><dt>status</dt><dd><span class="badge" :class="values.status">{{ values.status }}</span></dd></div>
      <div><dt>loading</dt><dd>{{ String(values.loading) }}</dd></div>
      <div><dt>amount (server total)</dt><dd>{{ formatAmount(values.amount) }}</dd></div>
      <div>
        <dt>paymentMethod</dt>
        <dd>{{ values.paymentMethod ? `${values.paymentMethod.brand} •• ${values.paymentMethod.last4}` : "—" }}</dd>
      </div>
      <div><dt>intentId</dt><dd><code>{{ values.intentId ?? "—" }}</code></dd></div>
    </dl>

    <p v-if="values.error" class="error">
      ⚠ {{ values.error.message }}<template v-if="values.error.code"> ({{ values.error.code }})</template>
    </p>

    <div class="row">
      <button :disabled="!canPay" @click="pay">{{ mode === "setup" ? "Save card" : "Pay" }}</button>
      <button class="ghost" @click="reset">Reset</button>
    </div>

    <p class="hint">
      The <strong>amount</strong> shown comes from the server's IntentBuilder, not the
      <code>amount-value</code> attribute — the Core owns the decision.
    </p>
  </main>
</template>
