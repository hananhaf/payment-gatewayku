import type { Invoice } from "../../gateway/types";

export async function createInvoice(amount: number): Promise<Invoice> {
  const res = await fetch("/api/invoices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amount }),
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
