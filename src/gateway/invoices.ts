import { randomBytes, randomInt } from "node:crypto";
import type { Pool, RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { convertQRIS } from "../core/index.ts";
import { selectMatch } from "./matcher.ts";
import type { CreateInvoiceOptions, GatewayConfig, Invoice, InvoiceStatus, Merchant } from "./types.ts";

interface Row extends RowDataPacket {
  id: string;
  merchant_id: string;
  base_amount: number;
  unique_amount: number;
  qr_string: string;
  status: string;
  order_id: string | null;
  callback_url: string | null;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}

function rowToInvoice(row: Row): Invoice {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    baseAmount: Number(row.base_amount),
    uniqueAmount: Number(row.unique_amount),
    qrString: row.qr_string,
    status: row.status as InvoiceStatus,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    paidAt: row.paid_at == null ? null : Number(row.paid_at),
    orderId: row.order_id ?? null,
    callbackUrl: row.callback_url ?? null,
  };
}

/** MySQL-backed invoice store. All methods are async. */
export class InvoiceStore {
  constructor(
    private pool: Pool,
    private config: GatewayConfig,
    private now: () => number = () => Date.now()
  ) {}

  private merchant(id: string): Merchant {
    const m = this.config.merchants.find((x) => x.id === id);
    if (!m) throw new Error(`unknown merchant: ${id}`);
    return m;
  }

  async expireStale(): Promise<void> {
    await this.pool.query(
      `UPDATE invoices SET status='expired' WHERE status='pending' AND expires_at < ?`,
      [this.now()]
    );
  }

  private async pendingForMerchant(merchantId: string): Promise<Invoice[]> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT * FROM invoices WHERE merchant_id=? AND status='pending'`,
      [merchantId]
    );
    return rows.map(rowToInvoice);
  }

  async findByIdempotency(merchantId: string, key: string): Promise<Invoice | null> {
    const [rows] = await this.pool.query<Row[]>(
      `SELECT * FROM invoices WHERE merchant_id=? AND idempotency_key=? LIMIT 1`,
      [merchantId, key]
    );
    return rows[0] ? rowToInvoice(rows[0]) : null;
  }

  async markCallbackSent(id: string): Promise<void> {
    await this.pool.query(`UPDATE invoices SET callback_sent=1 WHERE id=?`, [id]);
  }

  async create(merchantId: string, baseAmount: number, opts: CreateInvoiceOptions = {}): Promise<Invoice> {
    const merchant = this.merchant(merchantId);
    if (!Number.isInteger(baseAmount) || baseAmount <= 0) {
      throw new Error("baseAmount must be a positive integer (rupiah)");
    }
    const orderId = opts.orderId?.trim() || null;
    const callbackUrl = opts.callbackUrl?.trim() || null;
    const idempotencyKey = opts.idempotencyKey?.trim() || null;

    if (idempotencyKey) {
      const existing = await this.findByIdempotency(merchantId, idempotencyKey);
      if (existing) return existing;
    }

    await this.expireStale();
    const taken = new Set((await this.pendingForMerchant(merchantId)).map((i) => i.uniqueAmount));

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

    await this.pool.query(
      `INSERT INTO invoices
         (id, merchant_id, base_amount, unique_amount, qr_string, status, created_at, expires_at, paid_at,
          order_id, callback_url, idempotency_key, callback_sent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      [invoice.id, merchantId, baseAmount, uniqueAmount, invoice.qrString, "pending",
       now, invoice.expiresAt, null, orderId, callbackUrl, idempotencyKey]
    );

    return invoice;
  }

  async get(id: string): Promise<Invoice | null> {
    const [rows] = await this.pool.query<Row[]>(`SELECT * FROM invoices WHERE id=? LIMIT 1`, [id]);
    return rows[0] ? rowToInvoice(rows[0]) : null;
  }

  // Paid invoices, newest first. Optionally scoped to one merchant. Capped at 200.
  async listPaid(merchantId?: string): Promise<Invoice[]> {
    const [rows] = merchantId
      ? await this.pool.query<Row[]>(
          `SELECT * FROM invoices WHERE status='paid' AND merchant_id=? ORDER BY paid_at DESC LIMIT 200`,
          [merchantId]
        )
      : await this.pool.query<Row[]>(
          `SELECT * FROM invoices WHERE status='paid' ORDER BY paid_at DESC LIMIT 200`
        );
    return rows.map(rowToInvoice);
  }

  // Admin: all invoices (any status), newest first, optionally filtered. Capped at 500.
  async listAll(filter: { status?: InvoiceStatus; merchantId?: string; limit?: number } = {}): Promise<Invoice[]> {
    await this.expireStale();
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
    const [rows] = await this.pool.query<Row[]>(
      `SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT ${limit}`,
      params
    );
    return rows.map(rowToInvoice);
  }

  // Admin: headline counts for the dashboard. "Today" = server-local midnight.
  async stats(): Promise<{ pending: number; paidToday: number; revenueToday: number; paidTotal: number }> {
    await this.expireStale();
    const midnight = new Date(this.now());
    midnight.setHours(0, 0, 0, 0);
    const t0 = midnight.getTime();
    const one = async (sql: string, ...p: (string | number)[]): Promise<number> => {
      const [rows] = await this.pool.query<(RowDataPacket & { v: number })[]>(sql, p);
      return Number(rows[0]?.v ?? 0);
    };
    return {
      pending: await one(`SELECT COUNT(*) v FROM invoices WHERE status='pending'`),
      paidToday: await one(`SELECT COUNT(*) v FROM invoices WHERE status='paid' AND paid_at>=?`, t0),
      revenueToday: await one(
        `SELECT COALESCE(SUM(unique_amount),0) v FROM invoices WHERE status='paid' AND paid_at>=?`,
        t0
      ),
      paidTotal: await one(`SELECT COUNT(*) v FROM invoices WHERE status='paid'`),
    };
  }

  async settle(merchantId: string, amount: number): Promise<Invoice | null> {
    await this.expireStale();
    const match = selectMatch(await this.pendingForMerchant(merchantId), amount);
    if (!match) return null;
    const paidAt = this.now();
    // Guarded UPDATE: only the winner of a concurrent settle flips pending->paid.
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE invoices SET status='paid', paid_at=? WHERE id=? AND status='pending'`,
      [paidAt, match.id]
    );
    if (result.affectedRows === 0) return null;
    return { ...match, status: "paid", paidAt };
  }
}
