import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createInvoice, getInvoice, getMerchants, type MerchantOption } from "./api";
import type { Invoice } from "../../gateway/types";

export function Checkout() {
  const [merchants, setMerchants] = useState<MerchantOption[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Load merchants; preselect from ?merchant= or the first one.
  useEffect(() => {
    getMerchants()
      .then((list) => {
        setMerchants(list);
        const fromUrl = new URLSearchParams(window.location.search).get("merchant");
        const initial = list.find((m) => m.id === fromUrl)?.id ?? list[0]?.id ?? "";
        setMerchantId(initial);
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  useEffect(() => {
    if (invoice && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invoice.qrString, { width: 260 }).catch(() =>
        setError("Gagal membuat QR")
      );
    }
  }, [invoice?.qrString]);

  useEffect(() => {
    if (!invoice || invoice.status !== "pending") return;
    const timer = setInterval(async () => {
      try {
        setInvoice(await getInvoice(invoice.id));
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [invoice?.id, invoice?.status]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      setInvoice(await createInvoice(merchantId, Number(amount)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (invoice) {
    const merchantName = merchants.find((m) => m.id === invoice.merchantId)?.name ?? invoice.merchantId;
    return (
      <div style={{ maxWidth: 360, margin: "3rem auto", textAlign: "center" }}>
        <h1>Scan untuk Membayar</h1>
        <p style={{ color: "#666" }}>{merchantName}</p>
        <p>
          Bayar <strong>tepat</strong>: Rp {invoice.uniqueAmount.toLocaleString("id-ID")}
        </p>
        <canvas ref={canvasRef} />
        {invoice.status === "paid" ? (
          <p style={{ color: "green", fontWeight: 700 }}>✓ LUNAS</p>
        ) : invoice.status === "expired" ? (
          <p style={{ color: "orange" }}>Kedaluwarsa — buat transaksi baru</p>
        ) : (
          <p>Menunggu pembayaran…</p>
        )}
        <button onClick={() => setInvoice(null)}>Transaksi baru</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleCreate} style={{ maxWidth: 360, margin: "3rem auto", textAlign: "center" }}>
      <h1>QRIS Payment Gateway</h1>
      <label style={{ display: "block", margin: "1rem 0" }}>
        Merchant
        <select
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          required
          style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem" }}
        >
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <label style={{ display: "block", margin: "1rem 0" }}>
        Jumlah (Rupiah)
        <input
          type="number"
          min="1"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          style={{ display: "block", width: "100%", padding: "0.5rem", marginTop: "0.25rem" }}
        />
      </label>
      <button type="submit" disabled={!merchantId}>
        Buat QR Pembayaran
      </button>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </form>
  );
}
