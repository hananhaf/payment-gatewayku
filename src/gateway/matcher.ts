import type { Invoice } from "./types.ts";

/**
 * Extract an integer rupiah amount from a forwarded notification payload.
 * Prefers the app's own `amountDetected`; otherwise scans ALL notification text
 * fields (text/bigText/title/subText) for an "Rp 25.037" match. Scanning every
 * field — not just `text` — matters because banking apps (e.g. BNI Merchant) put
 * the amount in `bigText`/`title`, and JS `\s` also matches the non-breaking
 * space they often insert after "Rp", which the Android-side regex misses.
 */
export function parseAmount(payload: {
  amountDetected?: string | number | null;
  text?: string | null;
  bigText?: string | null;
  title?: string | null;
  subText?: string | null;
}): number | null {
  const detected = payload.amountDetected;
  if (typeof detected === "number" && Number.isInteger(detected) && detected > 0) {
    return detected;
  }
  if (typeof detected === "string" && /^\d+$/.test(detected.trim())) {
    return Number(detected.trim());
  }
  // Whole-rupiah only; strips '.' and ',' so thousands separators / cents are dropped.
  const haystack = [payload.text, payload.bigText, payload.title, payload.subText]
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  const m = haystack.match(/rp\s*([\d.,]+)/i);
  if (!m) return null;
  const digits = (m[1] ?? "").replace(/[.,]/g, "");
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
