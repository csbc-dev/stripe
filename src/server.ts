/**
 * Server-side entry point.
 *
 * The default barrel (`@csbc-dev/stripe`) re-exports `<stripe-checkout>`
 * which extends `HTMLElement`. Loading that class from Node throws
 * `ReferenceError: HTMLElement is not defined`, so server-side consumers
 * (Express/Fastify/Hono routes that create intents, handle webhooks, or
 * bridge a RemoteShellProxy) must use this entry instead.
 *
 * Exports only the headless pieces safe in Node:
 *   - `StripeCore`           (the wcBindable Core that holds the webhook secret)
 *   - `StripeSdkProvider`    (adapter for stripe-node)
 *   - types
 */
export { StripeCore } from "./core/StripeCore.js";
export { StripeSdkProvider, _internalResetWarnings } from "./providers/StripeSdkProvider.js";
export type {
  StripeNodeLike,
  StripeSdkProviderOptions,
  StripeSdkProviderIdempotencyContext,
} from "./providers/StripeSdkProvider.js";
export type {
  IStripeProvider, StripeMode, StripeStatus, StripeAmount, StripePaymentMethod, StripeError,
  StripeEvent, StripeIntentView, IntentRequestHint, IntentRequest, IntentBuilder,
  IntentBuilderResult, IntentCreationResult, ConfirmationReport,
  PaymentIntentOptions, SetupIntentOptions, WebhookHandler, WebhookRegisterOptions,
  ResumeAuthorizer, UserContext, WcsStripeCoreValues,
  // `stripe-checkout:unknown-status` is dispatched from the Core
  // (`_reconcileFromIntentView` source="core") as well as from the
  // Shell, so server-side bridges (`RemoteShellProxy`, observability
  // sinks attached at `core._target`) need the detail type to write
  // typed handlers. Without it, server code degrades to `as any`
  // casts on `CustomEvent.detail`. `WcsStripeValues` is deliberately
  // omitted: it adds the `trigger` slot, which only exists on the
  // Shell, and exposing it under `/server` would imply parity that
  // does not hold (the Shell entry is the canonical surface for
  // browser-side bindables).
  UnknownStatusDetail,
} from "./types.js";
