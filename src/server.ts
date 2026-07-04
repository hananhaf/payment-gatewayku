import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import express from "express";
import cors from "cors";
import type { InvoiceStore } from "./gateway/invoices.ts";
import { parseAmount } from "./gateway/matcher.ts";
import { registerAdminRoutes, requireAdmin } from "./gateway/admin.ts";
import type { Invoice, Merchant } from "./gateway/types.ts";

/** True if an IP is loopback / private / link-local / metadata / reserved (SSRF targets). */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 127 || a === 10 || a! >= 224 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b! >= 64 && b! <= 127) // CGNAT
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isBlockedIp(v.slice(7)); // IPv4-mapped
  return v === "::1" || v === "::" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd");
}

/**
 * SSRF guard for POS callback URLs: http(s) only, and the resolved host must not
 * be a private/loopback/metadata address. Set CALLBACK_ALLOW_PRIVATE=1 in dev/tests.
 */
async function callbackAllowed(urlStr: string): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (process.env.CALLBACK_ALLOW_PRIVATE === "1") return true;
  try {
    const addrs = await lookup(u.hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isBlockedIp(a.address));
  } catch {
    return false;
  }
}

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
  if (!(await callbackAllowed(inv.callbackUrl))) {
    console.error(`[callback] refused (SSRF guard / bad URL) for ${inv.id}: ${inv.callbackUrl}`);
    return;
  }
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
        redirect: "error", // don't let a 3xx bounce the callback to an internal host
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

function notificationPackageName(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const value = (body as Record<string, unknown>).packageName;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function notificationText(body: unknown): string | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const src = body as Record<string, unknown>;
  for (const key of ["text", "message", "title", "content"] as const) {
    const value = src[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function createServer(store: InvoiceStore, merchants: Merchant[] = []) {
  const fallbackById = new Map(merchants.map((m) => [m.id, m]));
  const fallbackByKey = new Map(merchants.map((m) => [m.apiKey, m]));
  const listMerchants = async () => (store.listMerchants ? store.listMerchants() : merchants);
  const merchantById = async (id: string) =>
    (store.getMerchantById ? await store.getMerchantById(id) : fallbackById.get(id)) ?? null;
  const merchantByKey = async (apiKey: string) =>
    (store.getMerchantByApiKey ? await store.getMerchantByApiKey(apiKey) : fallbackByKey.get(apiKey)) ?? null;
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  /** Resolve the merchant authenticated by the X-API-Key header (POS API). */
  const posMerchant = async (req: express.Request): Promise<Merchant | null> => {
    const key = req.headers["x-api-key"];
    return typeof key === "string" ? merchantByKey(key) : null;
  };

  app.get("/health", (_req, res) => {
    res.json({ status: "OK" });
  });

  // Public: merchant directory for the checkout page (id + name only)
  app.get("/api/merchants", async (_req, res) => {
    res.json((await listMerchants()).map((m) => ({ id: m.id, name: m.name })));
  });

  // Public: create an invoice (self-service checkout page).
  app.post("/api/invoices", async (req, res) => {
    const activeMerchants = await listMerchants();
    const merchantId =
      typeof req.body?.merchantId === "string" && req.body.merchantId.trim()
        ? req.body.merchantId.trim()
        : activeMerchants.length === 1
          ? activeMerchants[0]!.id
          : undefined;
    if (!merchantId) {
      res.status(400).json({ error: "merchantId is required" });
      return;
    }
    if (!(await merchantById(merchantId))) {
      res.status(404).json({ error: `unknown merchant: ${merchantId}` });
      return;
    }
    const amount = typeof req.body?.amount === "number" ? req.body.amount : Number(req.body?.amount);
    if (!Number.isInteger(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive integer (rupiah)" });
      return;
    }
    try {
      res.json(publicView(await store.create(merchantId, amount)));
    } catch (e) {
      res.status(503).json({ error: (e as Error).message });
    }
  });

  // ---------- POS / Merchant API (authenticated by X-API-Key = merchant apiKey) ----------

  // Create an invoice for the authenticated merchant, with optional orderId / callbackUrl / idempotencyKey.
  app.post("/api/pos/invoices", async (req, res) => {
    const merchant = await posMerchant(req);
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
      const inv = await store.create(merchant.id, amount, {
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
  app.get("/api/pos/invoices/:id", async (req, res) => {
    const merchant = await posMerchant(req);
    if (!merchant) {
      res.status(401).json({ error: "invalid or missing X-API-Key" });
      return;
    }
    const inv = await store.get(req.params.id);
    if (!inv || inv.merchantId !== merchant.id) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(publicView(inv));
  });

  // Admin console (login + monitoring + integration reference). No-op routes stay
  // registered even when ADMIN_PASSWORD is unset; they answer 503 via requireAdmin.
  registerAdminRoutes(app, store, merchants);

  // Paid transaction history (reveals revenue) — admin-only. POS/checkout use the
  // per-invoice endpoints below, which stay public.
  app.get("/api/history", requireAdmin, async (req, res) => {
    const merchantId = typeof req.query.merchantId === "string" ? req.query.merchantId : undefined;
    if (merchantId && !(await merchantById(merchantId))) {
      res.status(404).json({ error: `unknown merchant: ${merchantId}` });
      return;
    }
    res.json((await store.listPaid(merchantId)).map(publicView));
  });

  // Public: poll invoice status
  app.get("/api/invoices/:id", async (req, res) => {
    const inv = await store.get(req.params.id);
    if (!inv) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(publicView(inv));
  });

  // Protected: per-merchant notification webhook (from the NotificationListener device).
  const handleWebhook = async (merchantId: string, req: express.Request, res: express.Response) => {
    const merchant = await merchantById(merchantId);
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
      await store.logNotification({
        merchantId,
        amount: null,
        matchedInvoiceId: null,
        packageName: notificationPackageName(req.body),
        rawText: notificationText(req.body),
        rawPayload: req.body ?? {},
      });
      res.json({ matched: false, reason: "no amount detected" });
      return;
    }
    const inv = await store.settle(merchantId, amount);
    await store.logNotification({
      merchantId,
      amount,
      matchedInvoiceId: inv?.id ?? null,
      packageName: notificationPackageName(req.body),
      rawText: notificationText(req.body),
      rawPayload: req.body ?? {},
    });
    // Notify the POS if this invoice registered a callback. Fire-and-forget.
    if (inv?.callbackUrl) void deliverCallback(inv, merchant.apiKey, store);
    res.json({ matched: Boolean(inv), invoiceId: inv?.id ?? null });
  };

  app.post("/webhook/:merchantId", (req, res) => handleWebhook(req.params.merchantId, req, res));

  // Legacy single-merchant webhook: only valid when exactly one merchant exists.
  app.post("/webhook", async (req, res) => {
    const activeMerchants = await listMerchants();
    if (activeMerchants.length !== 1) {
      res.status(400).json({ error: "merchantId required: use /webhook/:merchantId" });
      return;
    }
    handleWebhook(activeMerchants[0]!.id, req, res);
  });

  return app;
}
