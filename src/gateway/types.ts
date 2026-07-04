export type InvoiceStatus = "pending" | "paid" | "expired";

export interface Merchant {
  id: string;
  name: string;
  qris: string;
  apiKey: string;
  active?: boolean;
}

export interface Invoice {
  id: string;
  merchantId: string;
  baseAmount: number;
  uniqueAmount: number;
  qrString: string;
  status: InvoiceStatus;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
  /** POS's own order reference (set via the authenticated POS API). */
  orderId: string | null;
  /** URL the gateway POSTs a signed "invoice.paid" callback to (POS API only). */
  callbackUrl: string | null;
}

/** Options for a POS-created invoice (authenticated). */
export interface CreateInvoiceOptions {
  orderId?: string;
  callbackUrl?: string;
  idempotencyKey?: string;
}

export interface NotificationAuditInput {
  merchantId: string;
  amount: number | null;
  matchedInvoiceId: string | null;
  packageName?: string | null;
  rawText?: string | null;
  rawPayload: unknown;
}

export interface GatewayConfig {
  merchants: Merchant[];
  port: number;
  invoiceTtlMs: number;
  maxOffset: number;
  dbPath: string;
}
