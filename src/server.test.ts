import { test } from "node:test";
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { openDb } from "./gateway/db.ts";
import { InvoiceStore } from "./gateway/invoices.ts";
import { createServer } from "./server.ts";
import type { GatewayConfig, Merchant } from "./gateway/types.ts";

const QRIS = "0002010102112604TEST5204000053033605802ID5904Toko6004Kota6304B1D8";
const MERCHANTS: Merchant[] = [
  { id: "a", name: "Merchant A", qris: QRIS, apiKey: "key-a" },
  { id: "b", name: "Merchant B", qris: QRIS, apiKey: "key-b" },
];

async function withServer(fn: (base: string, store: InvoiceStore) => Promise<void>) {
  const cfg: GatewayConfig = { merchants: MERCHANTS, port: 0, invoiceTtlMs: 600000, maxOffset: 999, dbPath: ":memory:" };
  const store = new InvoiceStore(openDb(":memory:"), cfg);
  const app = createServer(store, MERCHANTS);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
  }
}

const SINGLE: Merchant[] = [{ id: "default", name: "Default", qris: QRIS, apiKey: "key-d" }];
async function withSingleServer(fn: (base: string) => Promise<void>) {
  const cfg: GatewayConfig = { merchants: SINGLE, port: 0, invoiceTtlMs: 600000, maxOffset: 999, dbPath: ":memory:" };
  const store = new InvoiceStore(openDb(":memory:"), cfg);
  const app = createServer(store, SINGLE);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

const j = (extra: object = {}) => ({ headers: { "Content-Type": "application/json", ...(extra as any) } });

test("GET /api/merchants lists id+name only (no qris/apiKey)", async () => {
  await withServer(async (base) => {
    const body = await (await fetch(`${base}/api/merchants`)).json();
    assert.deepEqual(body, [{ id: "a", name: "Merchant A" }, { id: "b", name: "Merchant B" }]);
    assert.ok(!JSON.stringify(body).includes("key-a"));
    assert.ok(!JSON.stringify(body).includes(QRIS));
  });
});

test("POST /api/invoices with merchantId creates for that merchant", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ merchantId: "b", amount: 25000 }) });
    assert.equal(res.status, 200);
    const inv = await res.json();
    assert.equal(inv.merchantId, "b");
    assert.ok(inv.uniqueAmount > 25000);
  });
});

test("POST /api/invoices with unknown merchantId returns 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ merchantId: "zzz", amount: 25000 }) });
    assert.equal(res.status, 404);
  });
});

test("POST /api/invoices with a bad amount returns 400", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ merchantId: "a", amount: 0 }) });
    assert.equal(res.status, 400);
  });
});

test("webhook requires the correct per-merchant key", async () => {
  await withServer(async (base) => {
    const inv = await (await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ merchantId: "a", amount: 25000 }) })).json();
    // wrong key (merchant b's key on merchant a's webhook) -> 401
    const bad = await fetch(`${base}/webhook/a`, { method: "POST", ...j({ "X-API-Key": "key-b" }), body: JSON.stringify({ amountDetected: String(inv.uniqueAmount) }) });
    assert.equal(bad.status, 401);
    assert.equal((await (await fetch(`${base}/api/invoices/${inv.id}`)).json()).status, "pending");
    // correct key -> settles
    const ok = await fetch(`${base}/webhook/a`, { method: "POST", ...j({ "X-API-Key": "key-a" }), body: JSON.stringify({ amountDetected: String(inv.uniqueAmount) }) });
    const okBody = await ok.json();
    assert.equal(okBody.matched, true);
    assert.equal((await (await fetch(`${base}/api/invoices/${inv.id}`)).json()).status, "paid");
  });
});

test("webhook is isolated per merchant: b's webhook never settles a's invoice", async () => {
  await withServer(async (base) => {
    const invA = await (await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ merchantId: "a", amount: 25000 }) })).json();
    // hit merchant b's webhook (correct b key) with a's unique amount
    const res = await fetch(`${base}/webhook/b`, { method: "POST", ...j({ "X-API-Key": "key-b" }), body: JSON.stringify({ amountDetected: String(invA.uniqueAmount) }) });
    assert.equal((await res.json()).matched, false);
    assert.equal((await (await fetch(`${base}/api/invoices/${invA.id}`)).json()).status, "pending");
  });
});

test("webhook to unknown merchant returns 404", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/webhook/zzz`, { method: "POST", ...j({ "X-API-Key": "x" }), body: JSON.stringify({ amountDetected: "1" }) });
    assert.equal(res.status, 404);
  });
});

test("single-merchant: POST /api/invoices without merchantId uses the sole merchant", async () => {
  await withSingleServer(async (base) => {
    const res = await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ amount: 25000 }) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).merchantId, "default");
  });
});

test("single-merchant: legacy POST /webhook settles the sole merchant", async () => {
  await withSingleServer(async (base) => {
    const inv = await (await fetch(`${base}/api/invoices`, { method: "POST", ...j(), body: JSON.stringify({ amount: 25000 }) })).json();
    const res = await fetch(`${base}/webhook`, { method: "POST", ...j({ "X-API-Key": "key-d" }), body: JSON.stringify({ amountDetected: String(inv.uniqueAmount) }) });
    assert.equal((await res.json()).matched, true);
    assert.equal((await (await fetch(`${base}/api/invoices/${inv.id}`)).json()).status, "paid");
  });
});

test("multi-merchant: legacy POST /webhook returns 400 (merchantId required)", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/webhook`, { method: "POST", ...j({ "X-API-Key": "key-a" }), body: JSON.stringify({ amountDetected: "1" }) });
    assert.equal(res.status, 400);
  });
});
