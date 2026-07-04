import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert";
import { openTestDb } from "./test-support.ts";
import { InvoiceStore } from "./invoices.ts";
import type { GatewayConfig, Merchant } from "./types.ts";

let pool: Awaited<ReturnType<typeof openTestDb>>;
before(async () => { pool = await openTestDb(); });
beforeEach(async () => {
  await pool.query("TRUNCATE TABLE notifications");
  await pool.query("TRUNCATE TABLE invoices");
  await pool.query("TRUNCATE TABLE merchants");
});
after(async () => { await pool.end(); });

const QRIS = "0002010102112604TEST5204000053033605802ID5904Toko6004Kota6304B1D8";
const M: Merchant[] = [
  { id: "a", name: "A", qris: QRIS, apiKey: "ka" },
  { id: "b", name: "B", qris: QRIS, apiKey: "kb" },
];
function cfg(): GatewayConfig {
  return { merchants: M, port: 0, invoiceTtlMs: 600000, maxOffset: 999, dbPath: ":memory:" };
}
function store(now?: () => number) {
  return new InvoiceStore(pool, cfg(), now);
}

test("create ties the invoice to its merchant and builds a dynamic QR", async () => {
  const s = store();
  const inv = await s.create("a", 25000);
  assert.equal(inv.merchantId, "a");
  assert.ok(inv.uniqueAmount > 25000 && inv.uniqueAmount <= 25000 + 999);
  assert.ok(inv.qrString.includes(String(inv.uniqueAmount)));
  assert.ok(inv.qrString.includes("010212"));
});

test("create throws for an unknown merchant", async () => {
  const s = store();
  await assert.rejects(() => s.create("nope", 1000), /unknown merchant/i);
});

test("settle only matches invoices of the SAME merchant (isolation)", async () => {
  const s = store();
  const a = await s.create("a", 25000);
  // force b to collide on the exact same unique amount
  const bInv = await s.create("b", a.uniqueAmount - 1); // base+? ; ensure we can also test direct collision below
  assert.ok(bInv);
  // settling merchant b with a's unique amount must NOT settle a's invoice
  const settledOnB = await s.settle("b", a.uniqueAmount);
  // b has no pending invoice with a.uniqueAmount unless coincidental; assert a stays pending regardless
  assert.equal((await s.get(a.id))?.status, "pending");
  assert.notEqual(settledOnB?.id, a.id);
});

test("settle matches the correct merchant's invoice", async () => {
  const s = store();
  const a = await s.create("a", 25000);
  const settled = await s.settle("a", a.uniqueAmount);
  assert.equal(settled?.id, a.id);
  assert.equal(settled?.status, "paid");
  assert.equal((await s.get(a.id))?.status, "paid");
});

test("unique amount is unique among a merchant's own pending invoices", async () => {
  const s = store();
  const x = await s.create("a", 25000);
  const y = await s.create("a", 25000);
  assert.notEqual(x.uniqueAmount, y.uniqueAmount);
});

test("settle returns null when the merchant has no matching pending invoice", async () => {
  const s = store();
  await s.create("a", 25000);
  assert.equal(await s.settle("a", 99999), null);
});

test("expired invoices are not settled", async () => {
  let clock = 1000;
  const s = store(() => clock);
  const a = await s.create("a", 25000);
  clock = 1000 + 600001;
  assert.equal(await s.settle("a", a.uniqueAmount), null);
  assert.equal((await s.get(a.id))?.status, "expired");
});

test("listPaid returns only paid invoices, newest first, scoped by merchant", async () => {
  let clock = 1000;
  const s = store(() => clock);
  const a1 = await s.create("a", 25000);
  clock += 1;
  const a2 = await s.create("a", 30000);
  await s.create("b", 15000); // stays pending
  clock += 1;
  await s.settle("a", a1.uniqueAmount);
  clock += 1;
  await s.settle("a", a2.uniqueAmount); // paid last => should sort first

  const paidA = await s.listPaid("a");
  assert.deepEqual(paidA.map((i) => i.id), [a2.id, a1.id]);
  assert.ok(paidA.every((i) => i.status === "paid"));

  assert.equal((await s.listPaid("b")).length, 0); // b's invoice never settled
  assert.equal((await s.listPaid()).length, 2); // all merchants
});

test("same unique amount across two merchants settles only the intended one (deterministic)", async () => {
  const cfg: GatewayConfig = { merchants: M, port: 0, invoiceTtlMs: 600000, maxOffset: 1, dbPath: ":memory:" };
  const s = new InvoiceStore(pool, cfg);
  const a = await s.create("a", 25000); // maxOffset=1 => uniqueAmount = 25001
  const b = await s.create("b", 25000); // also 25001
  assert.equal(a.uniqueAmount, b.uniqueAmount);
  const settled = await s.settle("a", 25001);
  assert.equal(settled?.id, a.id);
  assert.equal((await s.get(a.id))?.status, "paid");
  assert.equal((await s.get(b.id))?.status, "pending"); // b MUST be untouched
});
