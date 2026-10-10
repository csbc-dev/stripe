import { test, expect } from "@playwright/test";
import { startServer } from "./server.js";

let server: Awaited<ReturnType<typeof startServer>>;

test.beforeAll(async () => {
  server = await startServer(0);
});

test.afterAll(async () => {
  await server.close();
});

test.beforeEach(() => {
  server.reset();
});

test("remote payment flow auto-prepares and submits through the fake Stripe.js bridge", async ({ page }) => {
  await page.goto(`http://localhost:${server.port}/client.html?scenario=submit`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.status).toBe("succeeded");
  expect(results.intentId).toMatch(/^pi_e2e_\d+$/);
  expect(results.amount).toEqual({ value: 1980, currency: "jpy" });
  expect(results.paymentMethod).toEqual({ id: "pm_card_visa", brand: "visa", last4: "4242" });
  expect(results.error).toBeNull();
  expect(results.elementReadyCount).toBe(1);
  expect(results.loaderCalls).toEqual(["pk_test_e2e"]);
  expect(results.confirmCalls).toEqual([
    { kind: "payment", clientSecret: `${results.intentId}_secret_ok` },
  ]);
  expect(results.statusEvents).toContain("collecting");
  expect(results.statusEvents).toContain("succeeded");

  expect(server.state.createCalls).toHaveLength(1);
  expect(server.state.createCalls[0].mode).toBe("payment");
  expect(server.state.createCalls[0].options).toMatchObject({ amount: 1980, currency: "jpy" });
});

test("remote payment flow without optional inputs and with a bare payment_method id reaches succeeded", async ({ page }) => {
  // Regression for @wc-bindable/remote >= 0.10 (strict JsonValue): the
  // prepare() hint used to carry `customerId: undefined` etc. and the
  // success report `paymentMethod: undefined`, both rejected before
  // sending. Runs over the real WebSocket + JSON boundary.
  await page.goto(`http://localhost:${server.port}/client.html?scenario=submit&minimal=1&pm=id`);
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.fatal).toBeUndefined();
  expect(results.status).toBe("succeeded");
  expect(results.intentId).toMatch(/^pi_e2e_\d+$/);
  expect(results.error).toBeNull();
  // The builder fell back to its defaults because no hint field was sent.
  expect(results.amount).toEqual({ value: 1111, currency: "usd" });
  expect(server.state.createCalls).toHaveLength(1);
  expect(server.state.createCalls[0].options).toMatchObject({ amount: 1111, currency: "usd" });
  // The report omitted `paymentMethod`, so the Core ran its server-side
  // retrieve fallback (SPEC §6.4) before settling on `succeeded`.
  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: results.intentId }]);
});

test("post-redirect resume hydrates remote state without mounting Stripe Elements", async ({ page }) => {
  server.state.resumeFixtures.set("pi_resume_ok", {
    id: "pi_resume_ok",
    mode: "payment",
    clientSecret: "pi_resume_ok_secret_ok",
    status: "succeeded",
    amount: { value: 2500, currency: "usd" },
    paymentMethod: { id: "pm_resume", brand: "visa", last4: "4242" },
  });

  await page.goto(
    `http://localhost:${server.port}/client.html?scenario=resume&payment_intent=pi_resume_ok&payment_intent_client_secret=pi_resume_ok_secret_ok&redirect_status=succeeded`,
  );
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.status).toBe("succeeded");
  expect(results.intentId).toBe("pi_resume_ok");
  expect(results.amount).toEqual({ value: 2500, currency: "usd" });
  expect(results.paymentMethod).toEqual({ id: "pm_resume", brand: "visa", last4: "4242" });
  expect(results.error).toBeNull();
  expect(results.loaderCalls).toEqual([]);
  expect(results.confirmCalls).toEqual([]);
  expect(results.elementReadyCount).toBe(0);
  expect(results.searchAfter).toBe("?scenario=resume");

  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_ok" }]);
});

test("post-redirect resume rejects a foreign client secret over the real remote boundary", async ({ page }) => {
  server.state.resumeFixtures.set("pi_resume_denied", {
    id: "pi_resume_denied",
    mode: "payment",
    clientSecret: "pi_resume_denied_secret_REAL",
    status: "succeeded",
    amount: { value: 9999, currency: "usd" },
    paymentMethod: { id: "pm_forbidden", brand: "visa", last4: "0000" },
  });

  await page.goto(
    `http://localhost:${server.port}/client.html?scenario=resume&payment_intent=pi_resume_denied&payment_intent_client_secret=pi_resume_denied_secret_GUESSED`,
  );
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.status).toBe("idle");
  expect(results.intentId).toBeNull();
  expect(results.paymentMethod).toBeNull();
  expect(results.error).toMatchObject({ code: "resume_client_secret_mismatch" });
  expect(results.loaderCalls).toEqual([]);
  expect(results.confirmCalls).toEqual([]);
  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_denied" }]);
  // A decisive denial consumes the redirect URL.
  expect(results.searchAfter).toBe("?scenario=resume");
});

test("post-redirect resume keeps the redirect URL when the provider fails without a Stripe code", async ({ page }) => {
  // No fixture: the fake provider's `retrieveIntent` throws a plain Error,
  // the shape of a network failure on the way to Stripe. The Core publishes
  // the sanitized (code-less) error before rejecting; that is a transient
  // failure, so the URL must survive for a retry — as it does with a local
  // Core. The resume goes out while the WebSocket is still connecting,
  // i.e. before the producer's `sync` snapshot is applied.
  await page.goto(
    `http://localhost:${server.port}/client.html?scenario=resume&payment_intent=pi_resume_unreachable&payment_intent_client_secret=pi_resume_unreachable_secret_ok&redirect_status=succeeded`,
  );
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.fatal).toBeUndefined();
  expect(results.status).toBe("idle");
  expect(results.intentId).toBeNull();
  expect(results.error).toEqual({ message: "Payment failed." });
  expect(results.searchAfter).toBe(
    "?scenario=resume&payment_intent=pi_resume_unreachable&payment_intent_client_secret=pi_resume_unreachable_secret_ok&redirect_status=succeeded",
  );
  // Auto-prepare stays blocked while the redirect is still pending.
  expect(results.loaderCalls).toEqual([]);
  expect(results.confirmCalls).toEqual([]);
  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_unreachable" }]);
});

test("post-redirect resume keeps the redirect URL and settles on idle when the provider returns no intent view", async ({ page }) => {
  // A custom provider whose `retrieveIntent` resolves with `null`. The Core
  // used to read `view.clientSecret` off it and reject with a raw
  // TypeError, staying on processing / loading=true. It now publishes a
  // fixed, code-less error and returns to idle; with no code the failure is
  // transient, so the URL survives for a retry.
  server.state.noViewIntents.add("pi_resume_no_view");
  await page.goto(
    `http://localhost:${server.port}/client.html?scenario=resume&payment_intent=pi_resume_no_view&payment_intent_client_secret=pi_resume_no_view_secret_ok&redirect_status=succeeded`,
  );
  await expect(page.locator("#status")).toHaveText("done", { timeout: 15000 });

  const results = JSON.parse((await page.locator("#results").textContent()) ?? "{}");

  expect(results.fatal).toBeUndefined();
  expect(results.status).toBe("idle");
  expect(results.loading).toBe(false);
  expect(results.intentId).toBeNull();
  expect(results.error).toEqual({
    message: "[@csbc-dev/stripe] provider.retrieveIntent did not return an intent view object.",
  });
  expect(results.searchAfter).toBe(
    "?scenario=resume&payment_intent=pi_resume_no_view&payment_intent_client_secret=pi_resume_no_view_secret_ok&redirect_status=succeeded",
  );
  expect(results.loaderCalls).toEqual([]);
  expect(results.confirmCalls).toEqual([]);
  expect(server.state.retrieveCalls).toEqual([{ mode: "payment", id: "pi_resume_no_view" }]);
});