import { test } from "node:test";
import assert from "node:assert";
import type { AddressInfo } from "node:net";
import { openDb } from "./gateway/db.ts";
import { InvoiceStore } from "./gateway/invoices.ts";
import { createServer } from "./server.ts";
import type { GatewayConfig } from "./gateway/types.ts";

const TEST_QRIS = "0002010102115802ID5904Toko6004Kota6304ABCD";
const API_KEY = "secret";

async function withServer(fn: (base: string, store: InvoiceStore) => Promise<void>) {
  const cfg: GatewayConfig = {
    staticQris: TEST_QRIS, apiKey: API_KEY, port: 0, invoiceTtlMs: 600000, maxOffset: 999,
    dbPath: ":memory:",
  };
  const store = new InvoiceStore(openDb(":memory:"), cfg);
  const app = createServer(store, API_KEY);
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    server.close();
  }
}

test("POST /api/invoices creates an invoice", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 25000 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.baseAmount, 25000);
    assert.ok(body.uniqueAmount > 25000);
    assert.ok(body.qrString.includes("010212"));
  });
});

test("POST /api/invoices rejects a bad amount", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/invoices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 0 }),
    });
    assert.equal(res.status, 400);
  });
});

test("GET /api/invoices/:id returns 404 for unknown id", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/invoices/nope`);
    assert.equal(res.status, 404);
  });
});

test("webhook without API key is rejected", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountDetected: "25037" }),
    });
    assert.equal(res.status, 401);
  });
});

test("end-to-end: create -> webhook match -> status paid", async () => {
  await withServer(async (base) => {
    const created = await (
      await fetch(`${base}/api/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 25000 }),
      })
    ).json();

    const hook = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({
        deviceId: "d1",
        packageName: "id.dana",
        amountDetected: String(created.uniqueAmount),
      }),
    });
    const hookBody = await hook.json();
    assert.equal(hookBody.matched, true);
    assert.equal(hookBody.invoiceId, created.id);

    const status = await (await fetch(`${base}/api/invoices/${created.id}`)).json();
    assert.equal(status.status, "paid");
  });
});

test("webhook with an unmatched amount reports matched:false", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
      body: JSON.stringify({ deviceId: "d1", packageName: "id.dana", amountDetected: "77777" }),
    });
    const body = await res.json();
    assert.equal(body.matched, false);
  });
});
