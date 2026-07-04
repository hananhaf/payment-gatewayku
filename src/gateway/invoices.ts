import { randomBytes, randomInt } from "node:crypto";
import type Database from "better-sqlite3";
import { convertQRIS } from "../core/index.ts";
import { selectMatch } from "./matcher.ts";
import type { CreateInvoiceOptions, GatewayConfig, Invoice, InvoiceStatus, Merchant } from "./types.ts";

interface Row {
  id: string;
  merchant_id: string;
  base_amount: number;
  unique_amount: number;
  qr_string: string;
  status: string;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
  order_id: string | null;
  callback_url: string | null;
}

function rowToInvoice(row: Row): Invoice {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    baseAmount: row.base_amount,
    uniqueAmount: row.unique_amount,
    qrString: row.qr_string,
    status: row.status as InvoiceStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at ?? null,
    orderId: row.order_id ?? null,
    callbackUrl: row.callback_url ?? null,
  };
}

export class InvoiceStore {
  constructor(
    private db: Database.Database,
    private config: GatewayConfig,
    private now: () => number = () => Date.now()
  ) {}

  private merchant(id: string): Merchant {
    const m = this.config.merchants.find((x) => x.id === id);
    if (!m) throw new Error(`unknown merchant: ${id}`);
    return m;
  }

  expireStale(): void {
    this.db
      .prepare(`UPDATE invoices SET status='expired' WHERE status='pending' AND expires_at < ?`)
      .run(this.now());
  }

  private pendingForMerchant(merchantId: string): Invoice[] {
    return (
      this.db
        .prepare(`SELECT * FROM invoices WHERE merchant_id=? AND status='pending'`)
        .all(merchantId) as Row[]
    ).map(rowToInvoice);
  }

  findByIdempotency(merchantId: string, key: string): Invoice | null {
    const row = this.db
      .prepare(`SELECT * FROM invoices WHERE merchant_id=? AND idempotency_key=?`)
      .get(merchantId, key) as Row | undefined;
    return row ? rowToInvoice(row) : null;
  }

  markCallbackSent(id: string): void {
    this.db.prepare(`UPDATE invoices SET callback_sent=1 WHERE id=?`).run(id);
  }

  create(merchantId: string, baseAmount: number, opts: CreateInvoiceOptions = {}): Invoice {
    const merchant = this.merchant(merchantId);
    if (!Number.isInteger(baseAmount) || baseAmount <= 0) {
      throw new Error("baseAmount must be a positive integer (rupiah)");
    }
    const orderId = opts.orderId?.trim() || null;
    const callbackUrl = opts.callbackUrl?.trim() || null;
    const idempotencyKey = opts.idempotencyKey?.trim() || null;

    // Idempotent replay: return the existing invoice for this (merchant, key).
    if (idempotencyKey) {
      const existing = this.findByIdempotency(merchantId, idempotencyKey);
      if (existing) return existing;
    }

    this.expireStale();
    const taken = new Set(this.pendingForMerchant(merchantId).map((i) => i.uniqueAmount));

    const free: number[] = [];
    for (let offset = 1; offset <= this.config.maxOffset; offset++) {
      const candidate = baseAmount + offset;
      if (!taken.has(candidate)) free.push(candidate);
    }
    if (free.length === 0) {
      throw new Error("Could not allocate a unique amount; too many pending invoices for this merchant");
    }
    const uniqueAmount = free[randomInt(free.length)]!;

    const now = this.now();
    const invoice: Invoice = {
      id: randomBytes(9).toString("hex"),
      merchantId,
      baseAmount,
      uniqueAmount,
      qrString: convertQRIS(merchant.qris, { amount: uniqueAmount }),
      status: "pending",
      createdAt: now,
      expiresAt: now + this.config.invoiceTtlMs,
      paidAt: null,
      orderId,
      callbackUrl,
    };

    this.db
      .prepare(
        `INSERT INTO invoices
           (id, merchant_id, base_amount, unique_amount, qr_string, status, created_at, expires_at, paid_at,
            order_id, callback_url, idempotency_key, callback_sent)
         VALUES
           (@id, @merchant_id, @base_amount, @unique_amount, @qr_string, @status, @created_at, @expires_at, @paid_at,
            @order_id, @callback_url, @idempotency_key, 0)`
      )
      .run({
        id: invoice.id,
        merchant_id: invoice.merchantId,
        base_amount: invoice.baseAmount,
        unique_amount: invoice.uniqueAmount,
        qr_string: invoice.qrString,
        status: invoice.status,
        created_at: invoice.createdAt,
        expires_at: invoice.expiresAt,
        paid_at: invoice.paidAt,
        order_id: orderId,
        callback_url: callbackUrl,
        idempotency_key: idempotencyKey,
      });

    return invoice;
  }

  get(id: string): Invoice | null {
    const row = this.db.prepare(`SELECT * FROM invoices WHERE id=?`).get(id) as Row | undefined;
    return row ? rowToInvoice(row) : null;
  }

  // Paid invoices, newest first. Optionally scoped to one merchant.
  // ponytail: capped at 200 — add pagination if a merchant outgrows one screen.
  listPaid(merchantId?: string): Invoice[] {
    const rows = merchantId
      ? this.db
          .prepare(`SELECT * FROM invoices WHERE status='paid' AND merchant_id=? ORDER BY paid_at DESC LIMIT 200`)
          .all(merchantId)
      : this.db
          .prepare(`SELECT * FROM invoices WHERE status='paid' ORDER BY paid_at DESC LIMIT 200`)
          .all();
    return (rows as Row[]).map(rowToInvoice);
  }

  // Admin: all invoices (any status), newest first, optionally filtered.
  // ponytail: capped at 500 — add pagination if the console outgrows one screen.
  listAll(filter: { status?: InvoiceStatus; merchantId?: string; limit?: number } = {}): Invoice[] {
    this.expireStale();
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      clauses.push("status=?");
      params.push(filter.status);
    }
    if (filter.merchantId) {
      clauses.push("merchant_id=?");
      params.push(filter.merchantId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
    const rows = this.db
      .prepare(`SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit);
    return (rows as Row[]).map(rowToInvoice);
  }

  // Admin: headline counts for the dashboard. "Today" = server-local midnight.
  stats(): { pending: number; paidToday: number; revenueToday: number; paidTotal: number } {
    this.expireStale();
    const midnight = new Date(this.now());
    midnight.setHours(0, 0, 0, 0);
    const t0 = midnight.getTime();
    const one = (sql: string, ...p: (string | number)[]) =>
      (this.db.prepare(sql).get(...p) as { v: number }).v;
    return {
      pending: one(`SELECT COUNT(*) v FROM invoices WHERE status='pending'`),
      paidToday: one(`SELECT COUNT(*) v FROM invoices WHERE status='paid' AND paid_at>=?`, t0),
      revenueToday: one(
        `SELECT COALESCE(SUM(unique_amount),0) v FROM invoices WHERE status='paid' AND paid_at>=?`,
        t0
      ),
      paidTotal: one(`SELECT COUNT(*) v FROM invoices WHERE status='paid'`),
    };
  }

  settle(merchantId: string, amount: number): Invoice | null {
    this.expireStale();
    const match = selectMatch(this.pendingForMerchant(merchantId), amount);
    if (!match) return null;
    const paidAt = this.now();
    this.db
      .prepare(`UPDATE invoices SET status='paid', paid_at=? WHERE id=? AND status='pending'`)
      .run(paidAt, match.id);
    return { ...match, status: "paid", paidAt };
  }
}
