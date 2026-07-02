import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createInvoice, getInvoice } from "./api";
import type { Invoice } from "../../gateway/types";

export function Checkout() {
  const [amount, setAmount] = useState("");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState("");
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (invoice && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invoice.qrString, { width: 260 });
    }
  }, [invoice]);

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
  }, [invoice]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      setInvoice(await createInvoice(Number(amount)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (invoice) {
    return (
      <div style={{ maxWidth: 360, margin: "3rem auto", textAlign: "center" }}>
        <h1>Scan untuk Membayar</h1>
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
      <button type="submit">Buat QR Pembayaran</button>
      {error && <p style={{ color: "red" }}>{error}</p>}
    </form>
  );
}
