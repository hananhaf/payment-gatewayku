import type { Invoice } from "../../gateway/types";

export interface MerchantOption { id: string; name: string; }

export async function getMerchants(): Promise<MerchantOption[]> {
  const res = await fetch("/api/merchants");
  if (!res.ok) throw new Error("Gagal memuat merchant");
  return res.json();
}

export async function createInvoice(merchantId: string, amount: number): Promise<Invoice> {
  const res = await fetch("/api/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ merchantId, amount }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Gagal membuat invoice");
  }
  return res.json();
}

export async function getInvoice(id: string): Promise<Invoice> {
  const res = await fetch(`/api/invoices/${id}`);
  if (!res.ok) throw new Error("Invoice tidak ditemukan");
  return res.json();
}

export async function getHistory(merchantId?: string): Promise<Invoice[]> {
  const qs = merchantId ? `?merchantId=${encodeURIComponent(merchantId)}` : "";
  const res = await fetch(`/api/history${qs}`);
  // /api/history is now admin-only; bounce anonymous viewers to the admin console.
  if (res.status === 401) {
    window.location.href = "/admin.html";
    throw new Error("Perlu login admin");
  }
  if (!res.ok) throw new Error("Gagal memuat riwayat");
  return res.json();
}
