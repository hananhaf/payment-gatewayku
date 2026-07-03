import { test } from "node:test";
import assert from "node:assert";
import { openDb } from "./db.ts";
import { InvoiceStore } from "./invoices.ts";
import type { GatewayConfig, Merchant } from "./types.ts";

const QRIS = "0002010102112604TEST5204000053033605802ID5904Toko6004Kota6304B1D8";
const M: Merchant[] = [
  { id: "a", name: "A", qris: QRIS, apiKey: "ka" },
  { id: "b", name: "B", qris: QRIS, apiKey: "kb" },
];
function cfg(): GatewayConfig {
  return { merchants: M, port: 0, invoiceTtlMs: 600000, maxOffset: 999, dbPath: ":memory:" };
}
function store(now?: () => number) {
  return new InvoiceStore(openDb(":memory:"), cfg(), now);
}

test("create ties the invoice to its merchant and builds a dynamic QR", () => {
  const s = store();
  const inv = s.create("a", 25000);
  assert.equal(inv.merchantId, "a");
  assert.ok(inv.uniqueAmount > 25000 && inv.uniqueAmount <= 25000 + 999);
  assert.ok(inv.qrString.includes(String(inv.uniqueAmount)));
  assert.ok(inv.qrString.includes("010212"));
});

test("create throws for an unknown merchant", () => {
  const s = store();
  assert.throws(() => s.create("nope", 1000), /unknown merchant/i);
});

test("settle only matches invoices of the SAME merchant (isolation)", () => {
  const s = store();
  const a = s.create("a", 25000);
  // force b to collide on the exact same unique amount
  const bInv = s.create("b", a.uniqueAmount - 1); // base+? ; ensure we can also test direct collision below
  assert.ok(bInv);
  // settling merchant b with a's unique amount must NOT settle a's invoice
  const settledOnB = s.settle("b", a.uniqueAmount);
  // b has no pending invoice with a.uniqueAmount unless coincidental; assert a stays pending regardless
  assert.equal(s.get(a.id)?.status, "pending");
  assert.notEqual(settledOnB?.id, a.id);
});

test("settle matches the correct merchant's invoice", () => {
  const s = store();
  const a = s.create("a", 25000);
  const settled = s.settle("a", a.uniqueAmount);
  assert.equal(settled?.id, a.id);
  assert.equal(settled?.status, "paid");
  assert.equal(s.get(a.id)?.status, "paid");
});

test("unique amount is unique among a merchant's own pending invoices", () => {
  const s = store();
  const x = s.create("a", 25000);
  const y = s.create("a", 25000);
  assert.notEqual(x.uniqueAmount, y.uniqueAmount);
});

test("settle returns null when the merchant has no matching pending invoice", () => {
  const s = store();
  s.create("a", 25000);
  assert.equal(s.settle("a", 99999), null);
});

test("expired invoices are not settled", () => {
  let clock = 1000;
  const s = store(() => clock);
  const a = s.create("a", 25000);
  clock = 1000 + 600001;
  assert.equal(s.settle("a", a.uniqueAmount), null);
  assert.equal(s.get(a.id)?.status, "expired");
});

test("same unique amount across two merchants settles only the intended one (deterministic)", () => {
  const cfg: GatewayConfig = { merchants: M, port: 0, invoiceTtlMs: 600000, maxOffset: 1, dbPath: ":memory:" };
  const s = new InvoiceStore(openDb(":memory:"), cfg);
  const a = s.create("a", 25000); // maxOffset=1 => uniqueAmount = 25001
  const b = s.create("b", 25000); // also 25001
  assert.equal(a.uniqueAmount, b.uniqueAmount);
  const settled = s.settle("a", 25001);
  assert.equal(settled?.id, a.id);
  assert.equal(s.get(a.id)?.status, "paid");
  assert.equal(s.get(b.id)?.status, "pending"); // b MUST be untouched
});
