export type InvoiceStatus = "pending" | "paid" | "expired";

/** How the customer pays. Both settle via the same unique-amount matching. */
export type PaymentMethod = "qris" | "bank_transfer";

export interface Merchant {
  id: string;
  name: string;
  qris: string;
  apiKey: string;
  active?: boolean;
  /** Optional bank account for the "bank_transfer" method. */
  bankName?: string | null;
  bankAccount?: string | null;
  bankHolder?: string | null;
}

export interface Invoice {
  id: string;
  merchantId: string;
  baseAmount: number;
  uniqueAmount: number;
  /** QRIS payload for method "qris"; empty string for "bank_transfer". */
  qrString: string;
  /** Payment channel; "bank_transfer" shows a bank account instead of a QR. */
  method: PaymentMethod;
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
  method?: PaymentMethod;
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
