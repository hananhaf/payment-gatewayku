import { test } from "node:test";
import assert from "node:assert";
import { openDb } from "./db.ts";
import { InvoiceStore } from "./invoices.ts";
import type { GatewayConfig } from "./types.ts";

const TEST_QRIS = "0002010102115802ID5904Toko6004Kota6304ABCD";

function cfg(): GatewayConfig {
  return { staticQris: TEST_QRIS, apiKey: "test", port: 0, invoiceTtlMs: 600000, maxOffset: 999 };
}

function freshStore(now?: () => number) {
  return new InvoiceStore(openDb(":memory:"), cfg(), now);
}

test("create allocates a unique amount above the base and a dynamic QR", () => {
  const store = freshStore();
  const inv = store.create(25000);
  assert.equal(inv.baseAmount, 25000);
  assert.ok(inv.uniqueAmount > 25000 && inv.uniqueAmount <= 25000 + 999);
  assert.equal(inv.status, "pending");
  // dynamic QRIS carries the amount in tag 54 and is dynamic (01 -> 12)
  assert.ok(inv.qrString.includes(String(inv.uniqueAmount)));
  assert.ok(inv.qrString.includes("010212"));
});

test("create rejects non-positive amounts", () => {
  const store = freshStore();
  assert.throws(() => store.create(0), /positive integer/);
  assert.throws(() => store.create(-5), /positive integer/);
});

test("two pending invoices for the same base never collide", () => {
  const store = freshStore();
  const a = store.create(25000);
  const b = store.create(25000);
  assert.notEqual(a.uniqueAmount, b.uniqueAmount);
});

test("get returns the stored invoice or null", () => {
  const store = freshStore();
  const inv = store.create(10000);
  assert.equal(store.get(inv.id)?.id, inv.id);
  assert.equal(store.get("nope"), null);
});

test("settle marks the matching pending invoice paid", () => {
  const store = freshStore();
  const inv = store.create(25000);
  const settled = store.settle(inv.uniqueAmount);
  assert.equal(settled?.id, inv.id);
  assert.equal(settled?.status, "paid");
  assert.ok(settled?.paidAt);
  assert.equal(store.get(inv.id)?.status, "paid");
});

test("settle returns null when no pending invoice matches", () => {
  const store = freshStore();
  store.create(25000);
  assert.equal(store.settle(99999), null);
});

test("expired invoices are not settled", () => {
  let clock = 1000;
  const store = freshStore(() => clock);
  const inv = store.create(25000);   // expires at 1000 + 600000
  clock = 1000 + 600001;             // advance past TTL
  assert.equal(store.settle(inv.uniqueAmount), null);
  assert.equal(store.get(inv.id)?.status, "expired");
});
