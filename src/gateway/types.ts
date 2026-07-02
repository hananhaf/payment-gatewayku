export type InvoiceStatus = "pending" | "paid" | "expired";

export interface Invoice {
  id: string;
  baseAmount: number;
  uniqueAmount: number;
  qrString: string;
  status: InvoiceStatus;
  createdAt: number;
  expiresAt: number;
  paidAt: number | null;
}

export interface GatewayConfig {
  staticQris: string;
  apiKey: string;
  port: number;
  invoiceTtlMs: number;
  maxOffset: number;
  dbPath: string;
}
