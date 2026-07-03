import { createHmac } from "node:crypto";
import express from "express";
import cors from "cors";
import type { InvoiceStore } from "./gateway/invoices.ts";
import { parseAmount } from "./gateway/matcher.ts";
import type { Invoice, Merchant } from "./gateway/types.ts";

/** Public shape of an invoice — never leaks the POS callback URL. */
function publicView(inv: Invoice) {
  const { callbackUrl, ...rest } = inv;
  void callbackUrl;
  return rest;
}

/** Absolute hosted-pay URL for an invoice, from the request's forwarded headers. */
function payUrl(req: express.Request, id: string): string {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const host = (req.headers["x-forwarded-host"] as string) || req.headers["host"] || "";
  return `${proto}://${host}/checkout.html?invoice=${id}`;
}

/** POST a signed "invoice.paid" callback to the POS, with a few retries. Fire-and-forget. */
async function deliverCallback(inv: Invoice, secret: string, store: InvoiceStore): Promise<void> {
  if (!inv.callbackUrl) return;
  const body = JSON.stringify({
    event: "invoice.paid",
    id: inv.id,
    orderId: inv.orderId,
    merchantId: inv.merchantId,
    amount: inv.uniqueAmount,
    baseAmount: inv.baseAmount,
    paidAt: inv.paidAt,
  });
  const signature = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(inv.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Signature": signature },
        body,
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        store.markCallbackSent(inv.id);
        return;
      }
    } catch {
      /* network error — retry */
    }
    await new Promise((r) => setTimeout(r, attempt * 1500));
  }
  console.error(`[callback] failed to deliver invoice.paid for ${inv.id} after 3 attempts`);
}

export function createServer(store: InvoiceStore, merchants: Merchant[]) {
  const byId = new Map(merchants.map((m) => [m.id, m]));
  const byKey = new Map(merchants.map((m) => [m.apiKey, m]));
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  /** Resolve the merchant authenticated by the X-API-Key header (POS API). */
  const posMerchant = (req: express.Request): Merchant | null => {
    const key = req.headers["x-api-key"];
    return (typeof key === "string" && byKey.get(key)) || null;
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "OK" });
  });

  // Public: merchant directory for the checkout page (id + name only)
  app.get("/api/merchants", (_req, res) => {
    res.json(merchants.map((m) => ({ id: m.id, name: m.name })));
  });

  // Public: create an invoice (self-service checkout page).
  app.post("/api/invoices", (req, res) => {
    const merchantId =
      typeof req.body?.merchantId === "string" && req.body.merchantId.trim()
        ? req.body.merchantId.trim()
        : merchants.length === 1
          ? merchants[0]!.id
          : undefined;
    if (!merchantId) {
      res.status(400).json({ error: "merchantId is required" });
      return;
    }
    if (!byId.has(merchantId)) {
      res.status(404).json({ error: `unknown merchant: ${merchantId}` });
      return;
    }
    const amount = typeof req.body?.amount === "number" ? req.body.amount : Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive integer (rupiah)" });
      return;
    }
    try {
      res.json(publicView(store.create(merchantId, amount)));
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });

  // ---------- POS / Merchant API (authenticated by X-API-Key = merchant apiKey) ----------

  // Create an invoice for the authenticated merchant, with optional orderId / callbackUrl / idempotencyKey.
  app.post("/api/pos/invoices", (req, res) => {
    const merchant = posMerchant(req);
    if (!merchant) {
      res.status(401).json({ error: "invalid or missing X-API-Key" });
      return;
    }
    const amount = typeof req.body?.amount === "number" ? req.body.amount : Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive integer (rupiah)" });
      return;
    }
    const callbackUrl = typeof req.body?.callbackUrl === "string" ? req.body.callbackUrl : undefined;
    if (callbackUrl && !/^https?:\/\//i.test(callbackUrl)) {
      res.status(400).json({ error: "callbackUrl must start with http:// or https://" });
      return;
    }
    try {
      const inv = store.create(merchant.id, amount, {
        orderId: typeof req.body?.orderId === "string" ? req.body.orderId : undefined,
        callbackUrl,
        idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : undefined,
      });
      res.json({ ...publicView(inv), payUrl: payUrl(req, inv.id) });
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });

  // Read one of the authenticated merchant's invoices.
  app.get("/api/pos/invoices/:id", (req, res) => {
    const merchant = posMerchant(req);
    if (!merchant) {
      res.status(401).json({ error: "invalid or missing X-API-Key" });
      return;
    }
    const inv = store.get(req.params.id);
    if (!inv || inv.merchantId !== merchant.id) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(publicView(inv));
  });

  // Public: paid transaction history, optionally scoped to ?merchantId=
  app.get("/api/history", (req, res) => {
    const merchantId = typeof req.query.merchantId === "string" ? req.query.merchantId : undefined;
    if (merchantId && !byId.has(merchantId)) {
      res.status(404).json({ error: `unknown merchant: ${merchantId}` });
      return;
    }
    res.json(store.listPaid(merchantId).map(publicView));
  });

  // Public: poll invoice status
  app.get("/api/invoices/:id", (req, res) => {
    const inv = store.get(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(publicView(inv));
  });

  // Protected: per-merchant notification webhook (from the NotificationListener device).
  const handleWebhook = (merchantId: string, req: express.Request, res: express.Response) => {
    const merchant = byId.get(merchantId);
    if (!merchant) {
      res.status(404).json({ error: `unknown merchant: ${merchantId}` });
      return;
    }
    if (req.headers["x-api-key"] !== merchant.apiKey) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }
    const amount = parseAmount(req.body ?? {});
    if (amount === null) {
      res.json({ matched: false, reason: "no amount detected" });
      return;
    }
    const inv = store.settle(merchantId, amount);
    // Notify the POS if this invoice registered a callback. Fire-and-forget.
    if (inv?.callbackUrl) void deliverCallback(inv, merchant.apiKey, store);
    res.json({ matched: Boolean(inv), invoiceId: inv?.id ?? null });
  };

  app.post("/webhook/:merchantId", (req, res) => handleWebhook(req.params.merchantId, req, res));

  // Legacy single-merchant webhook: only valid when exactly one merchant exists.
  app.post("/webhook", (req, res) => {
    if (merchants.length !== 1) {
      res.status(400).json({ error: "merchantId required: use /webhook/:merchantId" });
      return;
    }
    handleWebhook(merchants[0]!.id, req, res);
  });

  return app;
}
