import express from "express";
import cors from "cors";
import type { InvoiceStore } from "./gateway/invoices.ts";
import { parseAmount } from "./gateway/matcher.ts";

export function createServer(store: InvoiceStore, apiKey: string) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "OK" });
  });

  // Public: create an invoice (checkout page)
  app.post("/api/invoices", (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive integer (rupiah)" });
      return;
    }
    try {
      res.json(store.create(amount));
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

  // Protected: notification webhook from the NotificationListener APK
  app.post("/webhook", (req, res) => {
    if (req.headers["x-api-key"] !== apiKey) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }
    const amount = parseAmount(req.body ?? {});
    if (amount === null) {
      res.json({ matched: false, reason: "no amount detected" });
      return;
    }
    const inv = store.settle(amount);
    res.json({ matched: Boolean(inv), invoiceId: inv?.id ?? null });
  });

  return app;
}
