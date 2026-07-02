import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { convertQRIS } from "../core/index.ts";
import { selectMatch } from "./matcher.ts";
import type { GatewayConfig, Invoice, InvoiceStatus } from "./types.ts";

interface Row {
  id: string;
  base_amount: number;
  unique_amount: number;
  qr_string: string;
  status: string;
  created_at: number;
  expires_at: number;
  paid_at: number | null;
}

function rowToInvoice(row: Row): Invoice {
  return {
    id: row.id,
    baseAmount: row.base_amount,
    uniqueAmount: row.unique_amount,
    qrString: row.qr_string,
    status: row.status as InvoiceStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at ?? null,
  };
}

export class InvoiceStore {
  constructor(
    private db: Database.Database,
    private config: GatewayConfig,
    private now: () => number = () => Date.now()
  ) {}

  expireStale(): void {
    this.db
      .prepare(`UPDATE invoices SET status='expired' WHERE status='pending' AND expires_at < ?`)
      .run(this.now());
  }

  private pending(): Invoice[] {
    return (this.db.prepare(`SELECT * FROM invoices WHERE status='pending'`).all() as Row[]).map(
      rowToInvoice
    );
  }

  create(baseAmount: number): Invoice {
    if (!Number.isInteger(baseAmount) || baseAmount <= 0) {
      throw new Error("baseAmount must be a positive integer (rupiah)");
    }
    this.expireStale();
    const taken = new Set(this.pending().map((i) => i.uniqueAmount));

    let uniqueAmount = 0;
    for (let attempt = 0; attempt <= this.config.maxOffset; attempt++) {
      const offset = 1 + Math.floor(Math.random() * this.config.maxOffset);
      const candidate = baseAmount + offset;
      if (!taken.has(candidate)) {
        uniqueAmount = candidate;
        break;
      }
    }
    if (uniqueAmount === 0) {
      throw new Error("Could not allocate a unique amount; too many pending invoices");
    }

    const now = this.now();
    const invoice: Invoice = {
      id: randomBytes(9).toString("hex"),
      baseAmount,
      uniqueAmount,
      qrString: convertQRIS(this.config.staticQris, { amount: uniqueAmount }),
      status: "pending",
      createdAt: now,
      expiresAt: now + this.config.invoiceTtlMs,
      paidAt: null,
    };

    this.db
      .prepare(
        `INSERT INTO invoices
           (id, base_amount, unique_amount, qr_string, status, created_at, expires_at, paid_at)
         VALUES
           (@id, @base_amount, @unique_amount, @qr_string, @status, @created_at, @expires_at, @paid_at)`
      )
      .run({
        id: invoice.id,
        base_amount: invoice.baseAmount,
        unique_amount: invoice.uniqueAmount,
        qr_string: invoice.qrString,
        status: invoice.status,
        created_at: invoice.createdAt,
        expires_at: invoice.expiresAt,
        paid_at: invoice.paidAt,
      });

    return invoice;
  }

  get(id: string): Invoice | null {
    const row = this.db.prepare(`SELECT * FROM invoices WHERE id=?`).get(id) as Row | undefined;
    return row ? rowToInvoice(row) : null;
  }

  settle(amount: number): Invoice | null {
    this.expireStale();
    const match = selectMatch(this.pending(), amount);
    if (!match) return null;
    const paidAt = this.now();
    this.db
      .prepare(`UPDATE invoices SET status='paid', paid_at=? WHERE id=? AND status='pending'`)
      .run(paidAt, match.id);
    return { ...match, status: "paid", paidAt };
  }
}
