import { test } from "node:test";
import assert from "node:assert";
import { parseAmount, selectMatch } from "./matcher.ts";
import type { Invoice } from "./types.ts";

function inv(partial: Partial<Invoice>): Invoice {
  return {
    id: "x",
    baseAmount: 25000,
    uniqueAmount: 25037,
    qrString: "q",
    status: "pending",
    createdAt: 1,
    expiresAt: 999999,
    paidAt: null,
    ...partial,
  };
}

test("parseAmount reads amountDetected digits", () => {
  assert.equal(parseAmount({ amountDetected: "25037" }), 25037);
});

test("parseAmount falls back to 'Rp 25.037' in text", () => {
  assert.equal(parseAmount({ text: "Anda menerima Rp 25.037 dari ..." }), 25037);
});

test("parseAmount returns null when no amount present", () => {
  assert.equal(parseAmount({ text: "Notifikasi biasa tanpa nominal" }), null);
  assert.equal(parseAmount({}), null);
});

test("selectMatch returns the pending invoice with the exact amount", () => {
  const a = inv({ id: "a", uniqueAmount: 25037, createdAt: 10 });
  const b = inv({ id: "b", uniqueAmount: 50012, createdAt: 20 });
  assert.equal(selectMatch([a, b], 50012)?.id, "b");
});

test("selectMatch ignores non-pending invoices", () => {
  const paid = inv({ id: "a", uniqueAmount: 25037, status: "paid" });
  assert.equal(selectMatch([paid], 25037), null);
});

test("selectMatch picks the earliest when two share an amount", () => {
  const older = inv({ id: "old", uniqueAmount: 25037, createdAt: 5 });
  const newer = inv({ id: "new", uniqueAmount: 25037, createdAt: 50 });
  assert.equal(selectMatch([newer, older], 25037)?.id, "old");
});

test("selectMatch returns null on no match", () => {
  assert.equal(selectMatch([inv({ uniqueAmount: 25037 })], 99999), null);
});
