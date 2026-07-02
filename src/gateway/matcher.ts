import type { Invoice } from "./types.ts";

/**
 * Extract an integer rupiah amount from a forwarded notification payload.
 * Prefers the app's own `amountDetected`; falls back to an "Rp 25.037" match
 * in the notification text.
 */
export function parseAmount(payload: {
  amountDetected?: string | null;
  text?: string | null;
}): number | null {
  const raw = payload.amountDetected?.trim();
  if (raw && /^\d+$/.test(raw)) return Number(raw);

  // ponytail: whole-rupiah only; strips both '.' and ',' so any cents are dropped
  const m = (payload.text ?? "").match(/rp\s*([\d.,]+)/i);
  if (!m) return null;
  const digits = m[1].replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits)) return null;
  return Number(digits);
}

/**
 * Pick the pending invoice whose unique amount exactly equals the paid amount.
 * If several collide, the earliest-created wins.
 */
export function selectMatch(pending: Invoice[], amount: number): Invoice | null {
  const matches = pending
    .filter((i) => i.status === "pending" && i.uniqueAmount === amount)
    .sort((a, b) => a.createdAt - b.createdAt);
  return matches[0] ?? null;
}
