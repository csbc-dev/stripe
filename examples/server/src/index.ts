import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { RemoteShellProxy, WebSocketServerTransport } from "@wc-bindable/remote";
import type { WebSocketLike } from "@wc-bindable/remote";
import type { StripeCore } from "@csbc-dev/stripe/server";
import { createProviderFactory, createCore } from "./makeCore.js";

const PORT = Number(process.env.PORT ?? 8787);

const factory = await createProviderFactory();

// Every live Core, so the webhook endpoint can fan a verified event out to
// each session. Example-grade only — see the webhook note below.
const liveCores = new Set<StripeCore>();

// Example-grade upper bound on the buffered webhook body. Real Stripe events
// are well under this; the cap just prevents an oversized/abusive POST from
// growing `chunks` without limit. Production should also enforce limits at the
// proxy/load-balancer layer.
const MAX_WEBHOOK_BYTES = 1_048_576; // 1 MiB

function handleWebhook(req: IncomingMessage, res: ServerResponse): void {
  // CRITICAL: collect the RAW bytes. Signature verification needs the exact
  // body Stripe sent — do not run any JSON parser before `handleWebhook`.
  const chunks: Buffer[] = [];
  let total = 0;
  let aborted = false;
  req.on("data", (c: Buffer) => {
    if (aborted) return;
    total += c.length;
    if (total > MAX_WEBHOOK_BYTES) {
      aborted = true;
      res.writeHead(413, { "content-type": "text/plain" });
      res.end("payload too large");
      // Drain the rest of the body without buffering (the `aborted` guard
      // drops further chunks) instead of `req.destroy()`, which would reset
      // the connection mid-upload and prevent the client from cleanly reading
      // the 413 response.
      req.resume();
      return;
    }
    chunks.push(c);
  });
  // Surface a mid-stream transport error (client abort / connection reset)
  // instead of leaving an unhandled 'error' on the request stream, which would
  // otherwise crash the process.
  req.on("error", () => {
    if (aborted) return;
    aborted = true;
    if (!res.headersSent) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("request stream error");
    }
  });
  req.on("end", async () => {
    if (aborted) return;
    const raw = Buffer.concat(chunks);
    const sig = req.headers["stripe-signature"];

    if (!factory.webhookSecret) {
      // Mock mode (or real mode without STRIPE_WEBHOOK_SECRET): nothing to verify.
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("webhook secret not configured — skipped");
      return;
    }
    if (typeof sig !== "string") {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("missing stripe-signature header");
      return;
    }

    // Fan out to every live Core. Each Core dedups by `event.id` and only the
    // one whose active intent matches reacts. Production multi-tenant servers
    // MUST instead route to the owning session by intentId and add durable,
    // DB-backed idempotency (see ../../README.md and ../../SPEC.md §6.2 / §9).
    let signatureOrInputError = false;
    let handlerError = false;
    for (const core of liveCores) {
      try {
        await core.handleWebhook(raw, sig);
      } catch (err) {
        const e = err as { type?: string; message?: string };
        const isSig = e?.type === "StripeSignatureVerificationError";
        const isInput = typeof e?.message === "string" && e.message.startsWith("[@csbc-dev/stripe]");
        if (isSig || isInput) {
          signatureOrInputError = true;
        } else {
          // A fatal webhook handler throw (default fatal:true) is a genuine
          // fulfillment failure — return 5xx so Stripe retries delivery.
          handlerError = true;
          console.error("[webhook] handler error:", e?.message ?? err);
        }
      }
    }
    // 4xx => Stripe stops retrying (forged sig / unprocessable input);
    // 5xx => Stripe retries (transient fulfillment failure); 200 => acked.
    res.writeHead(signatureOrInputError ? 400 : handlerError ? 500 : 200);
    res.end();
  });
}

const httpServer = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: factory.live ? "live-stripe" : "mock" }));
    return;
  }
  if (req.method === "POST" && req.url === "/webhooks/stripe") {
    handleWebhook(req, res);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

// The browser <stripe-checkout> connects here in remote mode.
const wss = new WebSocketServer({ server: httpServer, path: "/stripe" });

wss.on("connection", (ws) => {
  const sessionId = randomUUID();
  const core = createCore(factory, sessionId);
  liveCores.add(core);

  // RemoteShellProxy binds to the Core's events and forwards them to this
  // client; it also applies the client's input writes + command invocations
  // back onto the Core.
  const transport = new WebSocketServerTransport(ws as unknown as WebSocketLike);
  const shell = new RemoteShellProxy(core, transport);

  const cleanup = (): void => {
    if (!liveCores.has(core)) return;
    liveCores.delete(core);
    try { shell.dispose(); } catch { /* already disposed */ }
    try { core.dispose(); } catch { /* already disposed */ }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

httpServer.listen(PORT, () => {
  console.log(`[stripe-core] ${factory.live ? "LIVE Stripe test mode" : "MOCK mode (no Stripe account)"}`);
  console.log(`[stripe-core] WS   ws://localhost:${PORT}/stripe`);
  console.log(`[stripe-core] POST http://localhost:${PORT}/webhooks/stripe`);
  console.log(`[stripe-core] GET  http://localhost:${PORT}/health`);
});
