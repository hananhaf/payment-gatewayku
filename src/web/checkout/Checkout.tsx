import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createInvoice, getInvoice, getMerchants, type BankInfo, type MerchantOption } from "./api";
import type { Invoice, PaymentMethod } from "../../gateway/types";

const rupiah = (n: number) => n.toLocaleString("id-ID");

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function Checkout() {
  const [merchants, setMerchants] = useState<MerchantOption[]>([]);
  const [merchantId, setMerchantId] = useState("");
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("qris");
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(() =>
    new URLSearchParams(window.location.search).has("invoice")
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Load merchants; preselect from ?merchant= or the first one.
  useEffect(() => {
    getMerchants()
      .then((list) => {
        setMerchants(list);
        const fromUrl = new URLSearchParams(window.location.search).get("merchant");
        setMerchantId(list.find((m) => m.id === fromUrl)?.id ?? list[0]?.id ?? "");
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  // Turnkey POS mode: ?invoice=<id> loads a pre-created invoice and shows its QR.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("invoice");
    if (!id) return;
    getInvoice(id)
      .then((inv) => {
        setNow(Date.now());
        setInvoice(inv);
      })
      .catch(() => setError("Invoice tidak ditemukan atau kedaluwarsa"))
      .finally(() => setBooting(false));
  }, []);

  // Render QR whenever the (pending/expired) QRIS invoice's payload is shown.
  useEffect(() => {
    if (invoice && invoice.method === "qris" && invoice.status !== "paid" && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invoice.qrString, { width: 232, margin: 0 }).catch(() =>
        setError("Gagal membuat QR")
      );
    }
  }, [invoice?.qrString, invoice?.status, invoice?.method]);

  // Poll status + tick the countdown while pending.
  useEffect(() => {
    if (!invoice || invoice.status !== "pending") return;
    let cancelled = false;
    const poll = setInterval(async () => {
      try {
        const updated = await getInvoice(invoice.id);
        if (!cancelled) setInvoice(updated);
      } catch {
        /* keep polling */
      }
    }, 3000);
    const tick = setInterval(() => !cancelled && setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [invoice?.id, invoice?.status]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setCreating(true);
    try {
      const inv = await createInvoice(merchantId, Number(amount), canBank ? method : "qris");
      setNow(Date.now());
      setInvoice(inv);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function copyAmount() {
    if (!invoice) return;
    try {
      await navigator.clipboard.writeText(String(invoice.uniqueAmount));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }

  function reset() {
    setInvoice(null);
    setAmount("");
    setMethod("qris");
    setCopied(false);
    setError("");
  }

  const merchantName = (id: string) => merchants.find((m) => m.id === id)?.name ?? id;
  const selected = merchants.find((m) => m.id === merchantId);
  const canBank = selected?.methods?.includes("bank_transfer") ?? false;

  // ---------- Loading a pre-created invoice (?invoice=) ----------
  if (booting && !invoice) {
    return (
      <main className="page">
        <Wordmark />
        <section className="card center">
          <p className="empty">Memuat invoice…</p>
        </section>
      </main>
    );
  }

  // ---------- Paid ----------
  if (invoice?.status === "paid") {
    return (
      <main className="page">
        <Wordmark />
        <section className="card center" role="status" aria-live="polite">
          <span className="merchant-tag">
            <StoreIcon /> {merchantName(invoice.merchantId)}
          </span>
          <div className="check" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h2 className="paid-title">Pembayaran Berhasil</h2>
          <p className="paid-sub">Rp {rupiah(invoice.uniqueAmount)} diterima</p>
          <button className="btn btn-primary" onClick={reset}>Transaksi Baru</button>
        </section>
      </main>
    );
  }

  // ---------- Pending / Expired ----------
  if (invoice) {
    const expired = invoice.status === "expired";
    const remaining = invoice.expiresAt - now;
    return (
      <main className="page">
        <Wordmark />
        <section className="card center" aria-live="polite">
          <span className="merchant-tag">
            <StoreIcon /> {merchantName(invoice.merchantId)}
          </span>
          <p className="amount-label">Bayar tepat sejumlah</p>
          <p className="amount-hero">
            <span className="cur">Rp</span>
            <span className="val">{rupiah(invoice.uniqueAmount)}</span>
          </p>
          <p className="pay-exact">
            Nominal <b>harus persis</b> agar terverifikasi otomatis
          </p>
          <button
            className={`copy-btn${copied ? " copied" : ""}`}
            onClick={copyAmount}
            type="button"
          >
            {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Tersalin" : "Salin nominal"}
          </button>

          {invoice.method === "bank_transfer" ? (
            <BankPanel
              bank={merchants.find((m) => m.id === invoice.merchantId)?.bank ?? null}
              expired={expired}
            />
          ) : (
            <div className={`qr-panel${expired ? " done" : ""}`}>
              <canvas ref={canvasRef} width={232} height={232} />
            </div>
          )}

          {expired ? (
            <div className="status expired">
              <ClockIcon /> Kedaluwarsa
            </div>
          ) : (
            <>
              <div className="status waiting">
                <span className="pulse" aria-hidden="true" />
                Menunggu pembayaran
              </div>
              <p className="timer">
                Berlaku <b>{mmss(remaining)}</b> lagi
              </p>
            </>
          )}

          <button className="btn btn-ghost" onClick={reset}>
            {expired ? "Buat Transaksi Baru" : "Batalkan"}
          </button>
        </section>
        <p className="hint">
          {invoice.method === "bank_transfer"
            ? "Transfer tepat ke rekening di atas, sesuai nominal"
            : "Pindai dengan aplikasi apa pun berlogo QRIS"}
        </p>
      </main>
    );
  }

  // ---------- Form ----------
  return (
    <main className="page">
      <Wordmark />
      <form className="card" onSubmit={handleCreate}>
        <h1>Buat Pembayaran</h1>
        <p className="sub">Masukkan merchant dan nominal untuk membuat QR</p>

        <div className="field">
          <label htmlFor="merchant">Merchant</label>
          <select
            id="merchant"
            className="select"
            value={merchantId}
            onChange={(e) => {
              setMerchantId(e.target.value);
              setMethod("qris");
            }}
            required
          >
            {merchants.length === 0 && <option value="">Memuat…</option>}
            {merchants.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>

        {canBank && (
          <div className="field">
            <label>Metode Pembayaran</label>
            <div className="method-toggle" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={method === "qris"}
                className={`method-opt${method === "qris" ? " on" : ""}`}
                onClick={() => setMethod("qris")}
              >
                <QrIcon /> QRIS
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={method === "bank_transfer"}
                className={`method-opt${method === "bank_transfer" ? " on" : ""}`}
                onClick={() => setMethod("bank_transfer")}
              >
                <BankIcon /> Transfer Bank
              </button>
            </div>
          </div>
        )}

        <div className="field">
          <label htmlFor="amount">Nominal</label>
          <div className="amount-wrap">
            <span className="prefix">Rp</span>
            <input
              id="amount"
              type="number"
              inputMode="numeric"
              min="1"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
        </div>

        <button className="btn btn-primary" type="submit" disabled={!merchantId || creating}>
          {creating ? (
            <span className="spinner" aria-hidden="true" />
          ) : canBank && method === "bank_transfer" ? (
            <BankIcon />
          ) : (
            <QrIcon />
          )}
          {creating
            ? "Membuat…"
            : canBank && method === "bank_transfer"
              ? "Buat Instruksi Transfer"
              : "Buat QR Pembayaran"}
        </button>

        {error && (
          <p className="error" role="alert">
            <AlertIcon /> {error}
          </p>
        )}
      </form>
      <a className="hint-link" href="/history.html">Lihat riwayat transaksi →</a>
    </main>
  );
}

/* ---------- inline SVG icons (no emoji) ---------- */
const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function Wordmark() {
  return (
    <div className="brand">
      <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 14h3v3M21 21v.01M17 21h.01M21 17v.01" />
      </svg>
      QRIS <span className="dot">Payment</span>
    </div>
  );
}
const StoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M3 9 4 4h16l1 5M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9M3 9h18" />
  </svg>
);
const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);
const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
);
const ClockIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
const QrIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3M21 21v.01M17 21h.01M21 17v.01" />
  </svg>
);
const AlertIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
);
const BankIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M3 10 12 4l9 6M4 10v9M20 10v9M8 10v9M16 10v9M3 21h18" />
  </svg>
);

/** Bank-transfer instruction panel — shows the destination account instead of a QR. */
function BankPanel({ bank, expired }: { bank: BankInfo | null; expired: boolean }) {
  const [copied, setCopied] = useState(false);
  if (!bank) {
    return <div className="bank-panel"><p className="empty">Rekening tidak tersedia</p></div>;
  }
  async function copyAccount() {
    try {
      await navigator.clipboard.writeText(bank!.account.replace(/\s+/g, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  }
  return (
    <div className={`bank-panel${expired ? " done" : ""}`}>
      {bank.name && <div className="bank-name"><BankIcon /> {bank.name}</div>}
      <div className="bank-account">{bank.account}</div>
      {bank.holder && <div className="bank-holder">a.n. {bank.holder}</div>}
      <button type="button" className={`copy-btn${copied ? " copied" : ""}`} onClick={copyAccount}>
        {copied ? <CheckIcon /> : <CopyIcon />} {copied ? "Tersalin" : "Salin no. rekening"}
      </button>
    </div>
  );
}
