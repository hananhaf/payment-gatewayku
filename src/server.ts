import express from "express";
import cors from "cors";
import type { InvoiceStore } from "./gateway/invoices.ts";
import { parseAmount } from "./gateway/matcher.ts";
import type { Merchant } from "./gateway/types.ts";

export function createServer(store: InvoiceStore, merchants: Merchant[]) {
  const byId = new Map(merchants.map((m) => [m.id, m]));
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "OK" });
  });

  // Public: merchant directory for the checkout page (id + name only)
  app.get("/api/merchants", (_req, res) => {
    res.json(merchants.map((m) => ({ id: m.id, name: m.name })));
  });

  // Public: create an invoice. merchantId optional only when there is exactly one merchant.
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
      res.json(store.create(merchantId, amount));
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });

  // Public: poll invoice status
  app.get("/api/invoices/:id", (req, res) => {
    const inv = store.get(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(inv);
  });

  // Protected: per-merchant webhook. The device for merchant :merchantId posts here
  // with that merchant's X-API-Key.
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
