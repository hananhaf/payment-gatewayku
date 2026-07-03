import { useEffect, useState } from "react";
import { getHistory, getMerchants, type MerchantOption } from "../checkout/api";
import type { Invoice } from "../../gateway/types";

const rupiah = (n: number) => n.toLocaleString("id-ID");
const when = (ms: number | null) =>
  ms ? new Date(ms).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "-";

export function History() {
  const [merchants, setMerchants] = useState<MerchantOption[]>([]);
  const [merchantId, setMerchantId] = useState(""); // "" = all merchants
  const [rows, setRows] = useState<Invoice[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMerchants().then(setMerchants).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    getHistory(merchantId || undefined)
      .then(setRows)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [merchantId]);

  const total = rows.reduce((sum, r) => sum + r.uniqueAmount, 0);
  const name = (id: string) => merchants.find((m) => m.id === id)?.name ?? id;
  const showMerchant = !merchantId && merchants.length > 1;

  return (
    <main className="page top">
      <Wordmark />
      <section className="card card-wide">
        <div className="history-head">
          <h1>Riwayat Transaksi</h1>
          <a className="hint-link" href="/checkout.html">+ Baru</a>
        </div>
        <p className="sub">Pembayaran yang sudah berhasil / lunas</p>

        {merchants.length > 1 && (
          <div className="field">
            <label htmlFor="merchant">Merchant</label>
            <select
              id="merchant"
              className="select"
              value={merchantId}
              onChange={(e) => setMerchantId(e.target.value)}
            >
              <option value="">Semua merchant</option>
              {merchants.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
        )}

        {error && <p className="error" role="alert">{error}</p>}

        {loading ? (
          <p className="empty">Memuat…</p>
        ) : rows.length === 0 ? (
          <p className="empty">Belum ada transaksi lunas.</p>
        ) : (
          <>
            <div className="summary">
              <span className="s-label">{rows.length} transaksi lunas</span>
              <span className="s-total"><span className="cur">Rp</span>{rupiah(total)}</span>
            </div>
            <ul className="txn-list">
              {rows.map((r) => (
                <li key={r.id} className="txn">
                  <div className="txn-left">
                    <div className="txn-time">{when(r.paidAt)}</div>
                    <div className="txn-sub">
                      {showMerchant && <span className="txn-merchant">{name(r.merchantId)}</span>}
                      <span className="txn-id">#{r.id.slice(0, 8)}</span>
                    </div>
                  </div>
                  <span className="txn-amount"><span className="cur">Rp</span>{rupiah(r.uniqueAmount)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}

function Wordmark() {
  return (
    <div className="brand">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <path d="M14 14h3v3M21 21v.01M17 21h.01M21 17v.01" />
      </svg>
      QRIS <span className="dot">Payment</span>
    </div>
  );
}
