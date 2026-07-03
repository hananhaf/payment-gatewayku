import { test } from "node:test";
import assert from "node:assert";
import { loadMerchants } from "./merchants.ts";

// NOTE: brief's original fixture "0002010102115802ID5904Toko6004Kota6304ABCD"
// fails validateQRIS (missing tags 52/53, no merchant-account tag 26-51, and
// "ABCD" is not the correct CRC for the payload). Replaced with a genuinely
// valid QRIS built from the same TLV shape (00/01/26/52/53/58/59/60/63) with
// a correct CRC16, so tests that expect loadMerchants() to *succeed* actually
// exercise the validateQRIS(valid) path instead of always throwing.
const QRIS = "0002010102112604TEST5204000053033605802ID5904Toko6004Kota6304B1D8";

test("loads merchants from MERCHANTS env JSON", () => {
  const env = { MERCHANTS: JSON.stringify([
    { id: "a", name: "A", qris: QRIS, apiKey: "ka" },
    { id: "b", name: "B", qris: QRIS, apiKey: "kb" },
  ]) } as unknown as NodeJS.ProcessEnv;
  const ms = loadMerchants(env);
  assert.equal(ms.length, 2);
  assert.equal(ms[0]!.id, "a");
  assert.equal(ms[1]!.apiKey, "kb");
});

test("falls back to STATIC_QRIS + API_KEY as a single 'default' merchant", () => {
  const env = { STATIC_QRIS: QRIS, API_KEY: "shh" } as unknown as NodeJS.ProcessEnv;
  const ms = loadMerchants(env);
  assert.equal(ms.length, 1);
  assert.equal(ms[0]!.id, "default");
  assert.equal(ms[0]!.qris, QRIS);
  assert.equal(ms[0]!.apiKey, "shh");
});

test("throws when no merchant source is configured", () => {
  assert.throws(() => loadMerchants({} as NodeJS.ProcessEnv), /no merchants configured/i);
});

test("throws on duplicate merchant ids", () => {
  const env = { MERCHANTS: JSON.stringify([
    { id: "a", name: "A", qris: QRIS, apiKey: "k1" },
    { id: "a", name: "A2", qris: QRIS, apiKey: "k2" },
  ]) } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadMerchants(env), /duplicate merchant id/i);
});

test("throws on a merchant missing required fields", () => {
  const env = { MERCHANTS: JSON.stringify([{ id: "a", name: "A", qris: QRIS }]) } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadMerchants(env), /apiKey/);
});

test("throws on structurally invalid QRIS (CRC check)", () => {
  const env = { MERCHANTS: JSON.stringify([{ id: "a", name: "A", qris: "not-a-qris", apiKey: "k" }]) } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadMerchants(env), /invalid QRIS/i);
});

test("throws on malformed MERCHANTS JSON", () => {
  const env = { MERCHANTS: "{not json" } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadMerchants(env), /MERCHANTS/);
});

test("throws on duplicate apiKeys across merchants", () => {
  const env = { MERCHANTS: JSON.stringify([
    { id: "a", name: "A", qris: QRIS, apiKey: "SAME" },
    { id: "b", name: "B", qris: QRIS, apiKey: "SAME" },
  ]) } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadMerchants(env), /duplicate apiKey/i);
});

test("throws a clear error on a null array element (not a raw TypeError)", () => {
  const env = { MERCHANTS: "[null]" } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadMerchants(env), /merchant #0 is not an object/);
});
