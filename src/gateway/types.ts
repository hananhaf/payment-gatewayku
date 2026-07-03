export type InvoiceStatus = "pending" | "paid" | "expired";

export interface Merchant {
  id: string;
  name: string;
  qris: string;
  apiKey: string;
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
}

export interface GatewayConfig {
  merchants: Merchant[];
  port: number;
  invoiceTtlMs: number;
  maxOffset: number;
  dbPath: string;
}
