import { test } from "node:test";
import assert from "node:assert";
import http from "node:http";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { openDb } from "./gateway/db.ts";
import { InvoiceStore } from "./gateway/invoices.ts";
import { createServer } from "./server.ts";
import type { GatewayConfig, Merchant } from "./gateway/types.ts";

const QRIS = "0002010102112604TEST5204000053033605802ID5904Toko6004Kota6304B1D8";
const MERCHANTS: Merchant[] = [
  { id: "a", name: "A", qris: QRIS, apiKey: "key-a" },
  { id: "b", name: "B", qris: QRIS, apiKey: "key-b" },
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

const J = (extra: Record<string, string> = {}) => ({
  headers: { "Content-Type": "application/json", ...extra },
});
const posCreate = (base: string, key: string, body: object) =>
  fetch(`${base}/api/pos/invoices`, { method: "POST", ...J({ "X-API-Key": key }), body: JSON.stringify(body) });

test("POS create requires a valid X-API-Key", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/pos/invoices`, { method: "POST", ...J(), body: JSON.stringify({ amount: 10000 }) })).status, 401);
    assert.equal((await posCreate(base, "wrong", { amount: 10000 })).status, 401);
  });
});

test("POS create returns the merchant's invoice with orderId + payUrl, no callbackUrl", async () => {
  await withServer(async (base) => {
    const res = await posCreate(base, "key-a", { amount: 25000, orderId: "ORD-1", callbackUrl: "https://shop.example/cb" });
    assert.equal(res.status, 200);
    const inv = await res.json();
    assert.equal(inv.merchantId, "a");
    assert.equal(inv.orderId, "ORD-1");
    assert.ok(inv.uniqueAmount > 25000);
    assert.ok(String(inv.payUrl).includes(`/checkout.html?invoice=${inv.id}`));
    assert.ok(!("callbackUrl" in inv), "callbackUrl must not be returned");
  });
});

test("POS create rejects a bad amount and a non-http callbackUrl", async () => {
  await withServer(async (base) => {
    assert.equal((await posCreate(base, "key-a", { amount: 0 })).status, 400);
    assert.equal((await posCreate(base, "key-a", { amount: 1000, callbackUrl: "ftp://x" })).status, 400);
  });
});

test("POS create is idempotent by idempotencyKey", async () => {
  await withServer(async (base) => {
    const a = await (await posCreate(base, "key-a", { amount: 25000, idempotencyKey: "abc" })).json();
    const b = await (await posCreate(base, "key-a", { amount: 25000, idempotencyKey: "abc" })).json();
    assert.equal(a.id, b.id);
  });
});

test("POS read is scoped to the authed merchant", async () => {
  await withServer(async (base) => {
    const inv = await (await posCreate(base, "key-a", { amount: 25000 })).json();
    assert.equal((await fetch(`${base}/api/pos/invoices/${inv.id}`, { headers: { "X-API-Key": "key-a" } })).status, 200);
    assert.equal((await fetch(`${base}/api/pos/invoices/${inv.id}`, { headers: { "X-API-Key": "key-b" } })).status, 404);
  });
});

test("public GET does not leak callbackUrl", async () => {
  await withServer(async (base) => {
    const inv = await (await posCreate(base, "key-a", { amount: 25000, callbackUrl: "https://shop.example/cb" })).json();
    const pub = await (await fetch(`${base}/api/invoices/${inv.id}`)).json();
    assert.ok(!("callbackUrl" in pub));
  });
});

test("a paid invoice fires a signed HMAC callback to the POS", async () => {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  let resolveGot: () => void;
  const gotOne = new Promise<void>((r) => (resolveGot = r));
  const recv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      received.push({ headers: req.headers, body: b });
      res.writeHead(200);
      res.end("ok");
      resolveGot();
    });
  });
  recv.listen(0);
  await new Promise((r) => recv.once("listening", r));
  const recvPort = (recv.address() as AddressInfo).port;

  try {
    await withServer(async (base) => {
      const inv = await (
        await posCreate(base, "key-a", {
          amount: 25000,
          orderId: "ORD-9",
          callbackUrl: `http://127.0.0.1:${recvPort}/cb`,
        })
      ).json();
      // Settle via the notification webhook.
      await fetch(`${base}/webhook/a`, { method: "POST", ...J({ "X-API-Key": "key-a" }), body: JSON.stringify({ amountDetected: String(inv.uniqueAmount) }) });
      await gotOne;

      assert.equal(received.length, 1);
      const { headers, body } = received[0]!;
      const expected = "sha256=" + createHmac("sha256", "key-a").update(body).digest("hex");
      assert.equal(headers["x-signature"], expected, "HMAC signature must verify with the merchant key");
      const payload = JSON.parse(body);
      assert.equal(payload.event, "invoice.paid");
      assert.equal(payload.id, inv.id);
      assert.equal(payload.orderId, "ORD-9");
      assert.equal(payload.amount, inv.uniqueAmount);
    });
  } finally {
    recv.close();
  }
});
